// /frontend/main.js
import { planUploadItems, DEFAULT_CHUNK_SIZE, generatePreview } from './chunked-upload.js';

// ---- API base (dev uses proxy; prod uses explicit base) -------------------
const DEV = !!(import.meta?.env?.DEV);
const API_BASE = DEV ? '' : (window.__API_BASE__ || import.meta?.env?.VITE_API_BASE || '');
console.info('[api] base =', API_BASE || '(relative via Vite proxy)');

export const ENDPOINTS = {
  DIRECT:   `${API_BASE}/upload`,
  CHUNK:    `${API_BASE}/upload-chunk`,
  STATUS:   `${API_BASE}/upload-status`,
  ASSEMBLE: `${API_BASE}/upload-manifest`,
  HEALTHZ:  `${API_BASE}/healthz`,
};

// --- quick reachability (helpful on mobile) --------------------------------
(async () => {
  try { console.info('[healthz]', (await fetch(ENDPOINTS.HEALTHZ, { cache: 'no-store' })).status); } catch (e) {
    console.error('Cannot reach API (check CORS/proxy/base URL):', e);
  }
  try {
    const r = await fetch(ENDPOINTS.CHUNK, { method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Origin': location.origin } });
    console.info('[preflight upload-chunk]', r.status);
  } catch (e) { console.warn('Preflight failed (expected if proxying):', e.message); }
})();

// ---------- config ----------
const THRESHOLD_BYTES    = 32 * 1024 * 1024;
const CHUNK_SIZE         = DEFAULT_CHUNK_SIZE;
const MAX_DIRECT_WORKERS = 3;
const MAX_CHUNK_WORKERS  = 4;

// ---------- state ----------
let paused = false;
let isUploading = false;
let isPaused = false;
let currentItems = [];

const seenKeys = new Set();
const STORAGE_DONE_KEY = 'uploaded_done_keys_v1';
function loadDoneKeys() { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_DONE_KEY) || '[]')); } catch { return new Set(); } }
function saveDoneKeys(set) { try { localStorage.setItem(STORAGE_DONE_KEY, JSON.stringify([...set])); } catch {} }
const doneKeys = loadDoneKeys();
const queueCount = () => currentItems.filter(i => !i.done).length;

// ---------- dom ----------
const fileInput   = document.getElementById('fileUpload');
const chooseBtn   = document.getElementById('chooseButton');
const cameraBtn   = document.getElementById('cameraButton');
const cameraInput = document.getElementById('cameraInput');
const dropZone    = document.getElementById('dropZone');

const btnStart    = document.getElementById('uploadButton');
const btnPause    = document.getElementById('pauseButton');
const btnResume   = document.getElementById('resumeButton');
const uploadList  = document.getElementById('uploadList');

let authKey = (document.getElementById('authKey')?.value || '').toString().trim() || '';
if (!authKey || authKey.includes('{{authKey')) {
  try { authKey = (new URLSearchParams(location.search).get('authKey') || '').trim(); } catch {}
}
console.log('authKey:', authKey ? authKey.slice(0,4) + '...' : '<none>');

// iOS banner (quality hint)
(() => {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (!isiOS) return;
  const banner = document.createElement('div');
  banner.style.cssText = 'padding:8px;background:#fff7e6;border:1px solid #ffd59e;margin:8px 0;font-size:13px;';
  banner.textContent = "On iOS: when selecting photos please choose 'Full Resolution' to preserve the highest quality.";
  document.querySelector('.picker-row')?.parentNode?.insertBefore(banner, document.querySelector('.picker-row'));
})();

// ===== In-page console with toggle FAB (enable via ?debug=1) ===============
(function () {
  const DEBUG_ON = new URLSearchParams(location.search).has('debug');
  if (!DEBUG_ON) return;

  let panel, body; const buf = []; const MAX = 600;
  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = '__uplog';
    panel.innerHTML = `
      <div class="hdr">
        <strong>logs</strong><span class="spacer"></span>
        <button data-act="copy">copy</button>
        <button data-act="clear">clear</button>
        <button data-act="hide">hide</button>
      </div>
      <pre class="body" aria-live="polite"></pre>`;
    document.documentElement.appendChild(panel);
    body = panel.querySelector('.body');
    panel.addEventListener('click', async (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'clear') { buf.length = 0; body.textContent = ''; }
      if (act === 'hide')  { panel.style.display = 'none'; }
      if (act === 'copy')  { try { await navigator.clipboard.writeText(body.textContent); } catch {} }
    });
  }
  function showPanel(){ ensurePanel(); panel.style.display='flex'; body.scrollTop = body.scrollHeight; }
  function push(type, parts) {
    const msg = parts.map(p => p instanceof Error ? (p.stack||p.message||String(p)) :
      (()=>{ try{return typeof p==='object'?JSON.stringify(p):String(p);}catch{return String(p);} })()).join(' ');
    buf.push(`[${new Date().toLocaleTimeString()}] ${type}: ${msg}`);
    if (buf.length > MAX) buf.shift();
    ensurePanel(); body.textContent = buf.join('\n'); body.scrollTop = body.scrollHeight;
  }
  ['log','info','warn','error'].forEach(k => { const orig = console[k]; console[k] = (...a)=>{ try{push(k,a);}catch{}; orig.apply(console,a); }; });
  window.addEventListener('error', e => push('error', [e.message, `${e.filename}:${e.lineno}`]));
  window.addEventListener('unhandledrejection', e => push('promise', [e.reason]));
  const f0 = window.fetch; window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    push('fetch ->', [init?.method || 'GET', url]);
    try { const res = await f0(input, init); push('fetch <-', [res.status, res.statusText, url]); return res; }
    catch (err) { push('fetch x', [url, err?.message || err]); throw err; }
  };
  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m,u,...rest){ this.__m=m; this.__u=u; return oOpen.call(this,m,u,...rest); };
  XMLHttpRequest.prototype.send = function (body){
    push('xhr ->', [this.__m||'?', this.__u||'?']);
    this.addEventListener('loadend', ()=> push('xhr <-', [this.status, this.__u||'?']));
    this.addEventListener('error',   ()=> push('xhr x',  [this.__u||'?']));
    return oSend.call(this, body);
  };
  const style = document.createElement('style'); style.textContent = `
    #__uplog{position:fixed;left:0;right:0;bottom:0;height:45vh;z-index:99999;
      background:#0b1020cc;color:#cfe3ff;font:12px/1.35 ui-monospace,monospace;
      box-shadow:0 -6px 24px rgba(0,0,0,.35);backdrop-filter:blur(4px);
      display:flex;flex-direction:column}
    #__uplog .hdr{display:flex;gap:.5rem;align-items:center;padding:.4rem .6rem;background:#0b1020e6}
    #__uplog .hdr .spacer{flex:1}
    #__uplog .hdr button{font:12px ui-monospace;padding:.2rem .5rem;border-radius:.4rem;border:1px solid #3a4a7a;background:#162040;color:#cfe3ff}
    #__uplog .body{margin:0;padding:.6rem;white-space:pre-wrap;overflow:auto;flex:1}
    #__uplog_fab{position:fixed;right:14px;bottom:14px;z-index:99998;border:none;border-radius:999px;
      padding:.6rem .9rem;background:#4c5cff;color:#fff;box-shadow:0 6px 16px rgba(0,0,0,.25);font-weight:700}
    @media (max-width:520px){ #__uplog{height:50vh} }`;
  document.head.appendChild(style);
  const fab = document.createElement('button'); fab.id='__uplog_fab'; fab.textContent='Logs';
  fab.onclick = () => { if (!panel || panel.style.display==='none') showPanel(); else panel.style.display='none'; };
  document.documentElement.appendChild(fab);
  console.info('[debug] in-page console active. Tap "hide" to remove.'); showPanel();
})();

// ---------- tiny utils ----------
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
};
const fmtSize   = n => (n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : (n/1024).toFixed(0)+' KB');
const keyForFile= f => `${f.name}|${f.size}|${f.lastModified||0}`;

// ---------- controls visibility ----------
function refreshControls() {
  const hasQueue = queueCount() > 0;
  if (!isUploading) {
    btnStart.style.display  = hasQueue ? 'inline-block' : 'none';
    btnPause.style.display  = 'none';
    btnResume.style.display = 'none';
    return;
  }
  btnStart.style.display  = 'none';
  btnPause.style.display  = isPaused ? 'none' : 'inline-block';
  btnResume.style.display = isPaused ? 'inline-block' : 'none';
}

// ---------- rows (.upload-item) ----------
function makeRow(item) {
  const row = el('div', { class: 'upload-item', id: `row-${item.id}` });

  const thumb = el('div', { class: 'thumb' }, el('img', { alt: '', src: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' }));
  const name  = el('div', { class: 'name', title: item.file.name }, item.file.name);
  const sub   = el('div', { class: 'subline' }, `${fmtSize(item.file.size)} · ${item.direct?'direct':'chunked'} · `,
                   el('span', { class: 'status', id: `status-${item.id}` }, 'queued'));
  const prog  = el('div', { class: 'progress-row' },
                   el('progress', { id: `bar-${item.id}`, max: item.direct ? 100 : item.chunks.length, value: 0 }),
                   el('span', { id: `pct-${item.id}`, class:'pct' }, '0%'));
  const meta  = el('div', { class: 'meta' }, name, sub, prog);

  const actions = el('div', { class: 'actions' },
    el('button', { class: 'trash', type: 'button', title: 'Remove', onclick: () => removeItem(item.id) }, '🗑️')
  );

  row.append(thumb, meta, actions);
  return row;
}
function setThumb(item, url) {
  const row = document.getElementById(`row-${item.id}`);
  const img = row?.querySelector('.thumb img');
  if (img && url) img.src = url;
}
function markRowState(row, state) {
  row.classList.remove('paused','done','failed','uploading');
  row.classList.add(state);
}
function removeItem(id) {
  const idx = currentItems.findIndex(i => i.id === id);
  if (idx !== -1) { try { seenKeys.delete(keyForFile(currentItems[idx].file)); } catch {} ; currentItems.splice(idx, 1); }
  document.getElementById(`row-${id}`)?.remove();
  if (!isUploading) refreshControls();
}

// ---------- network helpers ----------
async function getReceived(uploadId) {
  const r = await fetch(`${ENDPOINTS.STATUS}?hash=${encodeURIComponent(uploadId)}`);
  if (!r.ok) return new Set();
  const j = await r.json().catch(()=>({received:[]}));
  return new Set(j.received || []);
}
async function retryFetch(url, opts, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      if (i) console.warn(`retryFetch attempt ${i+1}/${tries} for ${url}`);
      const res = await fetch(url, opts);
      if (!res.ok) {
        const text = await res.text().catch(()=>'<no body>');
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 300 * 2**i)); }
  }
  throw last;
}

// ---------- direct uploads ----------
function uploadDirectOnce(item, bar, pct, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) { const p = Math.round(100*e.loaded/e.total); bar.value = p; pct.textContent = p+'%'; }
    };
    xhr.onload  = () => (xhr.status>=200 && xhr.status<300) ? (bar.value=100, pct.textContent='Done', item.done=true, resolve()) : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Aborted'));
    xhr.ontimeout = () => reject(new Error('Timeout'));
    xhr.timeout = timeoutMs;

    const form = new FormData();
    form.append('authKey', authKey);
    form.append('file', item.file, item.file.name);
    xhr.open('POST', ENDPOINTS.DIRECT);
    xhr.send(form);

    const t = setInterval(() => {
      if (paused && xhr.readyState !== 4) { try { xhr.abort(); } catch {} }
      if (xhr.readyState === 4) clearInterval(t);
    }, 100);
  });
}
async function uploadDirect(item, bar, pct) {
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (paused) throw new Error('Paused');
    try { await uploadDirectOnce(item, bar, pct, 120000); return; }
    catch (err) {
      console.warn(`uploadDirect attempt ${attempt} failed for ${item.file.name}:`, err);
      if (attempt === MAX_TRIES) throw err;
      await new Promise(r => setTimeout(r, 500 * 2**(attempt-1)));
      try { bar.value = 0; pct.textContent = '0%'; } catch {}
    }
  }
}

// ---------- chunked uploads ----------
async function uploadChunk(item, index, total) {
  const form = new FormData();
  form.append('authKey', authKey);
  form.append('uploadId', item.uploadId);
  form.append('index', String(index));
  form.append('totalChunks', String(total));
  form.append('hash', item.uploadId); // manifest key
  form.append('filename', item.file.name);
  form.append('isVideo', String(item.isVideo));
  form.append('chunk', item.chunks[index], `${item.file.name}.part${index}`);

  const CHUNK_UPLOAD_TRIES = 6;
  await retryFetch(ENDPOINTS.CHUNK, { method: 'POST', body: form }, CHUNK_UPLOAD_TRIES);
}
async function assembleOnServer(item) {
  const manifest = { uploadId: item.uploadId, totalChunks: item.chunks.length, filename: item.file.name, authKey, isVideo: item.isVideo };
  const form = new FormData(); form.append('manifest', JSON.stringify(manifest));
  const res = await fetch(ENDPOINTS.ASSEMBLE, { method: 'POST', body: form });
  const text = await res.text().catch(()=> '');
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}
async function waitForAllChunks(uploadId, total, attempts = 10, intervalMs = 300) {
  for (let i = 0; i < attempts; i++) {
    const received = await getReceived(uploadId);
    if (received.size >= total) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}
async function runChunked(item, bar, pct) {
  const MAX_ASSEMBLE_ATTEMPTS = 4;
  const backoff = n => 500 * 2**n;

  for (let attempt = 0; attempt < MAX_ASSEMBLE_ATTEMPTS; attempt++) {
    if (paused) throw new Error('Paused');

    const received = await getReceived(item.uploadId);

    // Upload missing chunks
    for (let ci = 0; ci < item.chunks.length; ci++) {
      if (paused) throw new Error('Paused');
      if (received.has(ci)) {
        bar.value = Math.max(bar.value, ci+1);
        pct.textContent = Math.round(100*(bar.value/item.chunks.length))+'%';
        continue;
      }
      await uploadChunk(item, ci, item.chunks.length);
      bar.value = Math.max(bar.value, ci+1);
      pct.textContent = Math.round(100*(bar.value/item.chunks.length))+'%';
    }

    try { await waitForAllChunks(item.uploadId, item.chunks.length, 12, 300); } catch {}
    const res = await assembleOnServer(item);
    if (res && res.ok && res.body && (res.body.success || res.body.warning)) {
      pct.textContent = 'Done'; item.done = true;
      try { doneKeys.add(keyForFile(item.file)); saveDoneKeys(doneKeys); } catch {}
      return;
    }

    // missing chunks?
    let missingIndices = [];
    if (res && res.body && Array.isArray(res.body.chunkStats)) {
      missingIndices = res.body.chunkStats
        .filter(s => s.exists===false || s.size===0)
        .map(s => Number(s.index)).filter(Number.isFinite);
    }
    if (!missingIndices.length) {
      const updated = await getReceived(item.uploadId);
      for (let i = 0; i < item.chunks.length; i++) if (!updated.has(i)) missingIndices.push(i);
    }
    if (!missingIndices.length) { await new Promise(r => setTimeout(r, backoff(attempt))); continue; }

    // re-upload only missing and try again
    for (const ci of missingIndices) {
      if (paused) throw new Error('Paused');
      await uploadChunk(item, ci, item.chunks.length);
      bar.value = Math.max(bar.value, ci+1);
      pct.textContent = Math.round(100*(bar.value/item.chunks.length))+'%';
    }
    await new Promise(r => setTimeout(r, backoff(attempt)));
  }
  throw new Error('Assemble failed after retries');
}

// ---------- mixed mode queue ----------
async function runUploadQueueMixed(items) {
  if (!authKey) { alert('authKey is required.'); return; }
  paused = false;

  // ensure rows exist (and mark pre-done items)
  for (const it of items) {
    if (doneKeys.has(keyForFile(it.file))) it.done = true;
    if (!document.getElementById(`row-${it.id}`)) uploadList.appendChild(makeRow(it));
    if (it.done) {
      const pct = document.getElementById(`pct-${it.id}`); if (pct) pct.textContent = 'Done';
      const bar = document.getElementById(`bar-${it.id}`); if (bar) bar.value = (it.direct ? 100 : it.chunks.length);
      const row = document.getElementById(`row-${it.id}`); if (row) markRowState(row, 'done');
    }
  }

  const direct  = items.filter(i => i.direct && !i.done);
  const chunked = items.filter(i => !i.direct && !i.done);
  const getBarPct = id => {
    const row = document.getElementById(`row-${id}`);
    return [row?.querySelector('progress'), row?.querySelector('.pct'), row];
  };

  let d = 0;
  const dWorkers = new Array(Math.min(MAX_DIRECT_WORKERS, direct.length)).fill(0).map(async () => {
    while (!paused) {
      const i = d++; if (i>=direct.length) return;
      const it = direct[i]; const [bar,pct,row] = getBarPct(it.id);
      if (row) markRowState(row, 'uploading');
      try { await uploadDirect(it, bar, pct); }
      catch (e) { console.error('uploadDirect final failure:', e); pct.textContent='Failed'; if (row) markRowState(row,'failed'); }
      if (it.done) { if (row) markRowState(row, 'done'); try { doneKeys.add(keyForFile(it.file)); saveDoneKeys(doneKeys); } catch {} }
    }
  });

  let c = 0;
  const cWorkers = new Array(Math.min(MAX_CHUNK_WORKERS, chunked.length)).fill(0).map(async () => {
    while (!paused) {
      const i = c++; if (i>=chunked.length) return;
      const it = chunked[i]; const [bar,pct,row] = getBarPct(it.id);
      if (row) markRowState(row, 'uploading');
      try { await runChunked(it, bar, pct); if (row && it.done) markRowState(row,'done'); }
      catch(e){ if (e?.message==='Paused') return; console.error(e); pct.textContent='Failed'; if (row) markRowState(row,'failed'); }
      if (it.done) { try { doneKeys.add(keyForFile(it.file)); saveDoneKeys(doneKeys); } catch {} }
    }
  });

  await Promise.all([...dWorkers, ...cWorkers]);
  onBatchFinished();
}

// ---------- intake: add files + immediate thumbs ----------
async function addFiles(fileList) {
  const files = Array.from(fileList || []);

  // remove completed items from DOM when user selects again
  currentItems = currentItems.filter(it => {
    if (it.done) { document.getElementById(`row-${it.id}`)?.remove(); return false; }
    return true;
  });

  // de-dupe (allow re-select of already uploaded to show "Done")
  const fresh = [];
  for (const f of files) {
    const k = keyForFile(f);
    if (seenKeys.has(k) && !doneKeys.has(k)) continue;
    seenKeys.add(k);
    fresh.push(f);
  }
  if (!fresh.length) { refreshControls(); return; }

  const newItems = planUploadItems(fresh, { chunkSize: CHUNK_SIZE, thresholdBytes: THRESHOLD_BYTES });
  for (const it of newItems) if (doneKeys.has(keyForFile(it.file))) it.done = true;
  currentItems.push(...newItems);

  for (const it of newItems) {
    uploadList.appendChild(makeRow(it));
    generatePreview(it.file).then(url => setThumb(it, url)).catch(() => {});
  }

  if (!isUploading) refreshControls();
  if (queueCount() > 0) {
    document.getElementById('uploadListWrapper')?.classList.remove('hidden');
  }
  else {
    document.getElementById('uploadListWrapper')?.classList.add('hidden');
  }
}

// ---------- controls wiring ----------
btnStart?.addEventListener('click', async () => {
  if (isUploading || !queueCount()) return;
  isUploading = true; isPaused = false; paused = false;
  refreshControls();
  await runUploadQueueMixed(currentItems);
});
btnPause?.addEventListener('click', () => {
  if (!isUploading || isPaused) return;
  isPaused = true; paused = true;
  refreshControls();
});
btnResume?.addEventListener('click', async () => {
  if (!isUploading || !isPaused) return;
  isPaused = false; paused = false;
  refreshControls();
  await runUploadQueueMixed(currentItems);
});
function onBatchFinished() {
  isUploading = false; isPaused = false; paused = false;
  refreshControls(); // Start stays hidden until new files are added
}

// ---------- picker & DnD ----------
chooseBtn?.addEventListener('click', () => fileInput?.click());
cameraBtn?.addEventListener('click', () => cameraInput?.click());
fileInput?.addEventListener('change', () => addFiles(fileInput.files));
cameraInput?.addEventListener('change', () => addFiles(cameraInput.files));

dropZone?.addEventListener('click', () => fileInput?.click());
dropZone?.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); fileInput?.click(); }});
['dragenter','dragover'].forEach(evt => dropZone?.addEventListener(evt, (e)=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(evt => dropZone?.addEventListener(evt, (e)=>{ e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('dragover'); }));
dropZone?.addEventListener('drop', (e) => { const f = e.dataTransfer?.files; if (f?.length) addFiles(f); });

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || []; const files = [];
  for (const it of items) if (it.kind==='file') { const f = it.getAsFile(); if (f) files.push(f); }
  if (files.length) addFiles(files);
});
