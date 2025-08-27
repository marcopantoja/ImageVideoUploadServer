// frontend/chunked-upload.js
// chunked-upload.js
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB

export function planUploadItems(files, {
  chunkSize = DEFAULT_CHUNK_SIZE,
  thresholdBytes = 32 * 1024 * 1024
} = {}) {
  const items = [];
  for (const file of files) {
  const uploadId = (typeof crypto?.randomUUID === 'function') ? crypto.randomUUID() : uuidv4();
    const isVideo = file.type?.startsWith('video/') ||
      /\.(mp4|mov|avi|mkv|webm|flv|ogv)$/i.test(file.name);
    const direct = file.size <= thresholdBytes;
    const chunks = direct ? [] : sliceBlob(file, chunkSize);
    items.push({ id: uploadId, uploadId, file, isVideo, direct, chunks, done: false });
  }
  return items;
}

// UUID v4 fallback using crypto.getRandomValues when available
function uuidv4() {
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : (typeof window !== 'undefined' && window.crypto) ? window.crypto : null;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  }
  // Last-resort fallback (not cryptographically strong)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function sliceBlob(file, size) {
  const out = [];
  for (let offset = 0; offset < file.size; offset += size) {
    out.push(file.slice(offset, Math.min(offset + size, file.size)));
  }
  return out;
}

/* -------- Thumbnails -------- */
export async function generatePreview(file) {
  // Some image types (notably TIFF) are not displayable in many browsers.
  // For those, return a small generated SVG placeholder instead of a raw
  // object URL which the <img> can't render.
  const name = (file.name || 'unknown').toString();
  const lname = name.toLowerCase();
  // Strict TIFF detection: match filename extension or exact MIME 'image/tiff'
  const isTiff = /\.(tif|tiff)$/i.test(name) || (file.type && file.type.toLowerCase() === 'image/tiff');
  // Debug: log filename, MIME type and decision to help diagnose why non-TIFFs
  try { console.debug('generatePreview:', { name, type: file.type, isTiff }); } catch(e){}
  if (isTiff) {
    // Generate a tiny SVG data URL with the extension as a hint
  const label = (name.split('.').pop() || 'IMG').toUpperCase();
  // First try: some browsers can decode TIFF-like blobs via createImageBitmap.
  // If supported, render a small raster thumbnail to a canvas for a real preview.
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      // Draw onto a small canvas (keep aspect ratio)
      const max = 80;
      const { width: w0, height: h0 } = bitmap;
      let w = w0, h = h0;
      if (w > h) { if (w > max) { h = Math.round(h * (max / w)); w = max; } }
      else { if (h > max) { w = Math.round(w * (max / h)); h = max; } }
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      // Free bitmap if possible
      try { if (bitmap.close) bitmap.close(); } catch(e){}
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      return dataUrl;
    }
  } catch (e) {
    // decoding failed or not supported; fall through to SVG fallback
    try { console.debug('TIFF decode via createImageBitmap failed, falling back to SVG', e); } catch(e){}
  }

  // Fallback: if UTIF is available, use it to decode the TIFF client-side.
  try {
    if (typeof UTIF !== 'undefined' && UTIF && typeof UTIF.decode === 'function') {
      try {
        const ab = await file.arrayBuffer();
        const ifds = UTIF.decode(ab);
        if (ifds && ifds.length) {
          UTIF.decodeImage(ab, ifds[0]);
          const rgba = UTIF.toRGBA8(ifds[0]);
          const w0 = ifds[0].width || 80, h0 = ifds[0].height || 80;
          // downscale to thumbnail size
          const max = 80;
          let w = w0, h = h0;
          if (w > h) { if (w > max) { h = Math.round(h * (max / w)); w = max; } }
          else { if (h > max) { w = Math.round(w * (max / h)); h = max; } }
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          // create ImageData from RGBA buffer possibly larger than target, so draw via temporary canvas
          const tmp = document.createElement('canvas'); tmp.width = w0; tmp.height = h0;
          const tctx = tmp.getContext('2d');
          const imgData = tctx.createImageData(w0, h0);
          imgData.data.set(new Uint8ClampedArray(rgba));
          tctx.putImageData(imgData, 0, 0);
          // draw scaled into final canvas
          ctx.drawImage(tmp, 0, 0, w, h);
          return canvas.toDataURL('image/jpeg', 0.75);
        }
      } catch (e) {
        try { console.debug('UTIF decode failed', e); } catch(e){}
      }
    }
  } catch (e) {}

  // Use literal '#' in colors and include charset; encodeURIComponent will
  // percent-escape the SVG payload correctly.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'><rect width='100%' height='100%' fill='#e8e8ee'/><text x='50%' y='50%' font-family='Helvetica, Arial, sans-serif' font-size='18' fill='#666' text-anchor='middle' dominant-baseline='central'>${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  if (file.type?.startsWith('image/')) {
    return URL.createObjectURL(file); // fast & memory-light; revoke on load if you like
  }
  if (file.type?.startsWith('video/')) {
    return await captureVideoFrame(file);
  }
  return ""; // fallback -> CSS icon
}

async function captureVideoFrame(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = url;
  video.muted = true;
  video.playsInline = true;

  // wait for dimensions
  await new Promise(res => video.addEventListener('loadedmetadata', res, { once: true }));
  try {
    video.currentTime = Math.min(0.1, video.duration || 0); // seek a hair in
    await new Promise(res => video.addEventListener('seeked', res, { once: true, passive: true }));
  } catch {}

  const w = video.videoWidth || 320, h = video.videoHeight || 180;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);

  URL.revokeObjectURL(url);
  return dataUrl;
}
