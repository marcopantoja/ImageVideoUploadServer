// server.js (clean, ESM)

import fastify from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import cors from '@fastify/cors';

import crypto from 'crypto';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { once } from 'events';
import { fileURLToPath } from 'url';

// ------------------------------------------------------------
// Paths & environment
// ------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV = process.env.NODE_ENV !== 'production';
const HOST = process.env.HOST || '127.0.0.1'; // keep prod behind cloudflared
const PORT = parseInt(process.env.PORT || '3000', 10);

const uploadDir     = '/mnt/data/FileUploadServer/uploads';
const authFile      = '/mnt/data/FileUploadServer/users.csv';
const logFile       = '/mnt/data/FileUploadServer/upload_log.json';
const tmpUploadDir  = path.join(uploadDir, 'tmp');        // direct temp & merged chunks
const chunkDir      = path.join(uploadDir, 'tmp_chunks'); // uploaded chunks
const manifestDir   = path.join(__dirname, 'manifests');  // chunk manifests

const ONE_HOUR   = 60 * 60 * 1000;
const LOCK_TTL   = parseInt(process.env.LOCK_TTL_MS || '', 10) || 10 * 60 * 1000; // 10 min
const TMP_TTL    = parseInt(process.env.TMP_TTL_MS  || '', 10) || 48 * ONE_HOUR;  // 48 h
const RES_LOG    = process.env.RES_LOG === '1';

const ensureDir = d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
[uploadDir, tmpUploadDir, chunkDir, manifestDir].forEach(ensureDir);

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
function hashingTee(algo = 'sha256') {
  const hash = crypto.createHash(algo);
  const t = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); this.push(chunk); cb(); }
  });
  t.digestHex = () => hash.digest('hex'); // call *after* pipeline() completes
  return t;
}

async function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.promises.rename(tmp, file);
}

const rmrf = async (p) => {
  try { await fs.promises.rm(p, { recursive: true, force: true }); } catch {}
};

function getChunkPath(uploadId, index) {
  return path.join(chunkDir, `${uploadId}_chunk_${index}`);
}
function getManifestPath(id) {
  return path.join(manifestDir, `${id}.json`);
}

// ------------------------------------------------------------
// Serial reservation via lock directory (extension-agnostic)
//   - "serial is sacred": Name_IMG-0026.* is unique regardless of ext
// ------------------------------------------------------------
function serialTag(prefix, n) {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}
function serialPaths(baseDir, name, prefix, n, ext = '') {
  const tag = serialTag(prefix, n);
  const baseNoExt = `${name}_${tag}`;
  const lockDir   = path.join(baseDir, `${baseNoExt}.lock`); // reservation lock
  const finalPath = path.join(baseDir, `${baseNoExt}${ext}`); // destination
  return { baseNoExt, lockDir, finalPath, tag };
}

async function isRealSerialUsed(baseDir, baseNoExt) {
  // true if we find: baseNoExt  OR  baseNoExt.<anything EXCEPT .lock/.serial>
  let names;
  try { names = await fs.promises.readdir(baseDir); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }

  const prefix = `${baseNoExt}`;
  for (const nm of names) {
    if (nm === prefix) return true;
    if (!nm.startsWith(prefix + '.')) continue;
    const ext = nm.slice(prefix.length + 1).toLowerCase();
    if (ext === 'lock' || ext === 'serial') continue; // ignore control files
    return true;
  }
  return false;
}

async function tryRemoveStaleLock(lockDir) {
  try {
    const st = await fs.promises.stat(lockDir);
    if (Date.now() - st.mtimeMs > LOCK_TTL) {
      await rmrf(lockDir);
      if (RES_LOG) console.info('[reserve] removed stale lock', lockDir);
      return true;
    }
  } catch {}
  return false;
}

async function reserveSerialPath(baseDir, name, isVideo, ext) {
  const prefix = isVideo ? 'VID' : 'IMG';

  for (let n = 0; n < 1e6; n++) {
    const { baseNoExt, lockDir, finalPath } = serialPaths(baseDir, name, prefix, n, ext);

    // Skip used serials fast
    if (await isRealSerialUsed(baseDir, baseNoExt)) {
      if (RES_LOG) console.info('[reserve] used:', baseNoExt);
      continue;
    }

    // Acquire lock (or clear stale)
    try {
      await fs.promises.mkdir(lockDir);
    } catch (e) {
      if (e.code === 'EEXIST') {
        const removed = await tryRemoveStaleLock(lockDir);
        if (!removed) { if (RES_LOG) console.info('[reserve] locked:', baseNoExt); }
        continue;
      }
      throw e;
    }

    // Re-check after lock to avoid races
    if (await isRealSerialUsed(baseDir, baseNoExt)) {
      await rmrf(lockDir);
      if (RES_LOG) console.info('[reserve] race used, unlock:', baseNoExt);
      continue;
    }

    if (RES_LOG) console.info('[reserve] OK:', baseNoExt, '->', path.basename(finalPath));
    return { finalPath, lockDir, n };
  }
  throw new Error('Could not allocate unique serial');
}

async function finalizeReservation(tmpPath, finalPath, lockDir) {
  try {
    await fs.promises.rename(tmpPath, finalPath);
  } catch {
    await fs.promises.copyFile(tmpPath, finalPath);
    await fs.promises.unlink(tmpPath).catch(() => {});
  } finally {
    await rmrf(lockDir);
  }
}

// ------------------------------------------------------------
// Chunk assembly (merge to temp + hash in one pass) – safer close
// ------------------------------------------------------------
async function assembleChunksToTemp(uploadId, totalChunks, tmpOutPath) {
  await fs.promises.mkdir(path.dirname(tmpOutPath), { recursive: true });
  const out = fs.createWriteStream(tmpOutPath);
  const hasher = crypto.createHash('sha256');

  try {
    for (let i = 0; i < totalChunks; i++) {
      const part = getChunkPath(uploadId, i);
      if (!fs.existsSync(part)) throw new Error(`Missing chunk #${i}`);

      // Pipe this source into the shared writer, hash as we go.
      await new Promise((resolve, reject) => {
        const r = fs.createReadStream(part);
        r.on('data', c => hasher.update(c));
        r.on('error', reject);
        r.on('end', () => { fs.unlink(part, () => resolve()); });
        r.pipe(out, { end: false });
      });
    }

    // Close writer only on success and wait for 'finish'
    out.end();
    await once(out, 'finish');
    return hasher.digest('hex');
  } catch (e) {
    out.destroy(); // tear down writer on error
    throw e;
  }
}

// ------------------------------------------------------------
// App bootstrap
// ------------------------------------------------------------
const app = fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);       // same-origin / curl
    if (DEV) return cb(null, true);           // allow in dev
    // tighten in production
    const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return cb(null, allowed.length ? allowed.includes(origin) : false);
  },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept'],
  maxAge: 86400
});

await app.register(multipart, {
  limits: {
    fieldNameSize: 100,
    fields: 20,
    files: 20,
    fileSize: 2 * 1024 * 1024 * 1024 // 2 GB
  }
});

await app.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  setHeaders: (res, filepath) => {
    if (/\.(woff2?|png|jpe?g|svg|ico)$/i.test(filepath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(js|css)$/i.test(filepath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
});

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'self'", 'https://sites.google.com', 'https://lh6.googleusercontent.com']
    }
  }
});

// ------------------------------------------------------------
// Auth (hot reload CSV)
// ------------------------------------------------------------
async function loadUsers() {
  return new Promise((resolve, reject) => {
    const map = {};
    fs.createReadStream(authFile)
      .pipe(csv())
      .on('data', (row) => { if (row.AuthKey) map[row.AuthKey.trim()] = (row.FullName || '').trim(); })
      .on('end', () => resolve(map))
      .on('error', reject);
  });
}
let users = {};
try { users = await loadUsers(); } catch { users = {}; }
fs.watchFile(authFile, { interval: 2000 }, async () => {
  try { users = await loadUsers(); app.log.info({ count: Object.keys(users).length }, 'Auth reloaded'); }
  catch (e) { app.log.error(e, 'Auth reload failed'); }
});

// ------------------------------------------------------------
// Upload log + global dedupe index (by SHA only)
// ------------------------------------------------------------
let uploadLog = [];
let hashIndex = new Map(); // sha256 -> savedName

if (fs.existsSync(logFile)) {
  try {
    uploadLog = JSON.parse(await fs.promises.readFile(logFile, 'utf8'));
    for (const e of uploadLog) {
      if (e?.hash && e?.savedName && !hashIndex.has(e.hash)) hashIndex.set(e.hash, e.savedName);
    }
  } catch {
    uploadLog = [];
  }
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------

// Index: inject authKey into HTML template if provided
app.get('/', async (req, reply) => {
  try {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    let html = await fs.promises.readFile(htmlPath, 'utf-8');

    const urlKey = (req.query?.authKey || '').toString().trim();
    const valid = !!(urlKey && users[urlKey]);
    const injected = valid ? urlKey : 'UNAUTHENTICATED';

    // inject into template; see index.html change below
    html = html.replace('{{authKey}}', injected);

    reply.type('text/html').send(html);
  } catch (err) {
    reply.code(500).send('Error loading page: ' + err);
  }
});

// Health
app.get('/healthz', async () => ({
  ok: true,
  host: HOST,
  port: PORT,
  pid: process.pid
}));

// Check if authKey is valid
app.post('/auth-check', async (req, reply) => {
  try {
    // Accept either JSON or multipart with a "authKey" field
    let key = '';
    const ct = (req.headers['content-type'] || '').toLowerCase();

    if (ct.includes('application/json')) {
      key = (req.body?.authKey || '').toString().trim();
    } else if (ct.includes('multipart/form-data')) {
      const parts = req.parts();
      for await (const p of parts) {
        if (p.type === 'field' && p.fieldname === 'authKey') { key = (p.value || '').trim(); break; }
      }
    } else {
      // also support x-www-form-urlencoded
      key = (req.body?.authKey || '').toString().trim();
    }

    const fullName = users[key];
    if (fullName) return reply.send({ valid: true, fullName });
    return reply.send({ valid: false });
  } catch {
    return reply.code(400).send({ valid: false });
  }
});

// Resume status (chunk): { received: [indices] }
app.get('/upload-status', async (req, reply) => {
  const id = (req.query?.hash || '').toString(); // client sends uploadId as "hash"
  if (!id) return reply.status(400).send({ error: 'Missing id' });

  const manifestPath = getManifestPath(id);
  if (!fs.existsSync(manifestPath)) return reply.send({ received: [] });

  try {
    const m = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    reply.send({ received: m.received || [] });
  } catch {
    reply.status(500).send({ error: 'Failed to read manifest' });
  }
});

// ---- Chunk: accept a single part and mark as received
app.post('/upload-chunk', async (req, reply) => {
  try {
    const parts = req.parts();

    let authKey = null;
    let uploadId = null;
    let index = null;
    let totalChunks = null;
    let filename = null;
    let isVideo = false;

    // We will either write directly to the final chunk path,
    // or (if fields haven't arrived yet) to a temporary path and rename later.
    let wrotePath = null;      // where the bytes ended up
    let wroteTemp = false;     // did we write to a temp path?
    let sawFile = false;       // did we receive the file part?

    for await (const part of parts) {
      if (part.type === 'field') {
        const val = (part.value || '').toString();
        switch (part.fieldname) {
          case 'authKey':      authKey = val.trim(); break;
          case 'uploadId':     uploadId = val.trim(); break;
          case 'index':        index = parseInt(val, 10); break;
          case 'totalChunks':  totalChunks = parseInt(val, 10); break;
          case 'filename':     filename = val; break;
          case 'isVideo':      isVideo = /^true$/i.test(val); break;
        }
        continue;
      }

      if (part.type === 'file' && part.fieldname === 'chunk') {
        sawFile = true;

        if (uploadId && index != null) {
          wrotePath = getChunkPath(uploadId, index);
          req.log.info({ uploadId, index, wrotePath }, 'chunk: writing direct');
          await pipeline(part.file, fs.createWriteStream(wrotePath));
        } else {
          const tmpName = `.inflight.${Date.now()}-${Math.random().toString(36).slice(2)}`;
          wrotePath = path.join(chunkDir, tmpName);
          wroteTemp = true;
          req.log.info({ tmp: wrotePath }, 'chunk: writing temp (fields not ready yet)');
          await pipeline(part.file, fs.createWriteStream(wrotePath));
        }
      }
    }

    // Basic validation (after consuming the body so we don't hang)
    if (!authKey || !users[authKey]) return reply.status(403).send({ error: 'Invalid authKey' });
    if (!uploadId || index == null || totalChunks == null || !sawFile) {
      return reply.status(400).send({ error: 'Missing fields for chunk' });
    }

    if (wroteTemp) {
      const finalPath = getChunkPath(uploadId, index);
      req.log.info({ from: wrotePath, to: finalPath }, 'chunk: renaming temp -> final');
      await fs.promises.rename(wrotePath, finalPath);
      wrotePath = finalPath;
    }

    // Update manifest: mark this index as received
    const manifestPath = getManifestPath(uploadId);
    let manifest = { uploadId, filename, totalChunks, isVideo, received: [], mtime: Date.now() };
    if (fs.existsSync(manifestPath)) {
      try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8')); }
      catch {}
    }
    if (!manifest.received.includes(index)) manifest.received.push(index);
    manifest.mtime = Date.now();
    await writeJsonAtomic(manifestPath, manifest);

    const size = await fs.promises.stat(wrotePath).then(s => s.size).catch(() => 0);
    req.log.info({ uploadId, index, size }, 'chunk ok');

    return reply.send({ ok: true, index });
  } catch (e) {
    req.log.error(e, 'chunk upload failed');
    return reply.status(500).send({ error: 'Chunk upload failed' });
  }
});

// ---- Chunk finalize: assemble -> hash -> global dedupe -> reserve -> finalize -> log
app.post('/upload-manifest', async (req, reply) => {
  try {
    const parts = req.parts();
    let manifest = null;

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'manifest') {
        try { manifest = JSON.parse(part.value); }
        catch { return reply.status(400).send({ error: 'Invalid manifest JSON' }); }
      }
    }
    if (!manifest || !manifest.uploadId || !manifest.totalChunks || !manifest.filename || !manifest.authKey) {
      return reply.status(400).send({ error: 'Missing manifest fields' });
    }

    const { uploadId, totalChunks, filename, authKey, isVideo } = manifest;
    const user = users[authKey];
    if (!user) return reply.status(403).send({ error: 'Invalid authKey' });

    const ext = path.extname(filename || '');
    const tempOut = path.join(tmpUploadDir, `.merge.${crypto.randomUUID()}${ext}`);

    // Merge + hash
    const sha256 = await assembleChunksToTemp(uploadId, totalChunks, tempOut);

    // Global dedupe by content hash only
    const existing = hashIndex.get(sha256);
    if (existing) {
      await fs.promises.unlink(tempOut).catch(() => {});
      await fs.promises.unlink(getManifestPath(uploadId)).catch(() => {});
      uploadLog.push({
        authKey, fullName: user, originalName: filename,
        savedName: existing, timestamp: new Date().toISOString(),
        hash: sha256, deduped: true
      });
      await writeJsonAtomic(logFile, uploadLog);
      return reply.send({ success: true, deduped: true, existing });
    }

    // Reserve serial (ext-agnostic) & finalize
    const { finalPath, lockDir } = await reserveSerialPath(uploadDir, user, !!isVideo, ext);
    await finalizeReservation(tempOut, finalPath, lockDir);

    const savedName = path.basename(finalPath);
    hashIndex.set(sha256, savedName);
    uploadLog.push({
      authKey, fullName: user, originalName: filename,
      savedName, timestamp: new Date().toISOString(), hash: sha256
    });
    await writeJsonAtomic(logFile, uploadLog);

    // Clean manifest
    await fs.promises.unlink(getManifestPath(uploadId)).catch(() => {});

    return reply.send({ success: true, savedAs: savedName, sha256 });
  } catch (e) {
    req.log.error(e, 'assembly failed');
    return reply.status(500).send({ error: 'Assembly failed' });
  }
});

// ---- Direct multipart upload (small files; may include multiple parts)
app.post('/upload', async (req, reply) => {
  try {
    const parts = req.parts();

    let authKey = null;
    let user = null;
    const staged = []; // { tmpPath, sha256, ext, isVideo, originalName }

    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'authKey') {
          authKey = (part.value || '').trim();
          user = users[authKey] || null;
        }
        continue;
      }

      const ext = path.extname(part.filename || '');
      const isVideo =
        part.mimetype?.startsWith('video/') ||
        ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.ogv'].includes(ext.toLowerCase());

      const tmpPath = path.join(tmpUploadDir, `${Date.now()}_${Math.random().toString(36).slice(2)}_${part.filename}`);
      await fs.promises.mkdir(path.dirname(tmpPath), { recursive: true });

      const tee = hashingTee('sha256');
      await pipeline(part.file, tee, fs.createWriteStream(tmpPath));
      staged.push({ tmpPath, sha256: tee.digestHex(), ext, isVideo, originalName: part.filename });
    }

    if (!authKey || !user) {
      await Promise.allSettled(staged.map(s => fs.promises.unlink(s.tmpPath)));
      return reply.status(403).send({ error: 'Invalid or missing authKey' });
    }

    const savedFiles = [];

    for (const s of staged) {
      // Global dedupe by content hash only
      const existing = hashIndex.get(s.sha256);
      if (existing) {
        await fs.promises.unlink(s.tmpPath).catch(() => {});
        uploadLog.push({
          authKey, fullName: user, originalName: s.originalName,
          savedName: existing, timestamp: new Date().toISOString(),
          hash: s.sha256, deduped: true
        });
        continue;
      }

      const { finalPath, lockDir } = await reserveSerialPath(uploadDir, user, s.isVideo, s.ext);
      await finalizeReservation(s.tmpPath, finalPath, lockDir);

      const savedName = path.basename(finalPath);
      hashIndex.set(s.sha256, savedName);
      uploadLog.push({
        authKey, fullName: user, originalName: s.originalName,
        savedName, timestamp: new Date().toISOString(), hash: s.sha256
      });
      savedFiles.push(savedName);
    }

    await writeJsonAtomic(logFile, uploadLog);
    return reply.send({ success: true, files: savedFiles });
  } catch (err) {
    req.log.error(err, 'direct upload failed');
    return reply.status(500).send({ error: 'Upload failed' });
  }
});

// ------------------------------------------------------------
// Automatic cleanup of stale locks, temps, chunks, manifests
// ------------------------------------------------------------
async function cleanupOnce() {
  const now = Date.now();

  // 1) Stale lock dirs + legacy .serial files
  try {
    for await (const d of await fs.promises.opendir(uploadDir)) {
      const fp = path.join(uploadDir, d.name);
      if (d.isDirectory() && d.name.endsWith('.lock')) {
        const st = await fs.promises.stat(fp).catch(() => null);
        if (st && (now - st.mtimeMs > LOCK_TTL)) await rmrf(fp);
      }
      if (d.isFile() && d.name.endsWith('.serial')) {
        const st = await fs.promises.stat(fp).catch(() => null);
        if (st && (now - st.mtimeMs > LOCK_TTL)) await rmrf(fp);
      }
    }
  } catch {}

  // 2) Old temp files
  try {
    for await (const d of await fs.promises.opendir(tmpUploadDir)) {
      const fp = path.join(tmpUploadDir, d.name);
      const st = await fs.promises.stat(fp).catch(() => null);
      if (st && (now - st.mtimeMs > TMP_TTL)) await rmrf(fp);
    }
  } catch {}

  // 3) Old chunks
  try {
    for await (const d of await fs.promises.opendir(chunkDir)) {
      const fp = path.join(chunkDir, d.name);
      const st = await fs.promises.stat(fp).catch(() => null);
      if (st && (now - st.mtimeMs > TMP_TTL)) await rmrf(fp);
    }
  } catch {}

  // 4) Old manifests
  try {
    for await (const d of await fs.promises.opendir(manifestDir)) {
      if (!d.name.endsWith('.json')) continue;
      const fp = path.join(manifestDir, d.name);
      const st = await fs.promises.stat(fp).catch(() => null);
      if (st && (now - st.mtimeMs > TMP_TTL)) await rmrf(fp);
    }
  } catch {}
}

setInterval(() => { cleanupOnce().catch(e => app.log.error(e, 'cleanup failed')); }, ONE_HOUR);
cleanupOnce().catch(() => {}); // run once on boot

// ------------------------------------------------------------
// Launch
// ------------------------------------------------------------
app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`Server running at ${address}`);
});
// Graceful shutdown
process.on('SIGINT', () => { 
  app.log.info('SIGINT received, shutting down gracefully'); 
  app.close().then(() => {
    app.log.info('Server shut down gracefully');
    process.exit(0);
  }).catch(err => {
    app.log.error(err, 'Error shutting down server');
    process.exit(1);
  });
});
