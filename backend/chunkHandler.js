// backend/chunkHandler.js
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tmpChunkDir = path.resolve(__dirname, '../uploads/tmp_chunks');
const finalDir = path.resolve(__dirname, '../uploads/merged');
const manifestDir = path.resolve(__dirname, '../manifests');

export async function registerChunkRoutes(app, users, getFileHash, getNextFileName, uploadLog, logFile) {
  // Ensure directories exist
  [tmpChunkDir, finalDir, manifestDir].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

  app.post('/upload-chunk', async (req, reply) => {
    try {
      const parts = req.parts();
    let meta = {};
    let chunkBuffer = null;

      for await (const part of parts) {
      if (part.type === 'file') {
        chunkBuffer = await part.toBuffer();
      } else if (part.type === 'field') {
        meta[part.fieldname] = part.value;
      }
    }

  // Normalize field names: client may send hash/index/filename while server
  // expects fileHash/chunkIndex/originalName. Accept either to be robust.
  const authKey = meta.authKey || meta.AuthKey || meta.auth || '';
  const fileHash = meta.fileHash || meta.hash || meta.uploadId || '';
  const chunkIndex = Number(meta.chunkIndex ?? meta.index ?? meta.partIndex ?? -1);
  const totalChunks = Number(meta.totalChunks ?? meta.total ?? meta.totalchunks ?? 0);
  const originalName = meta.originalName || meta.filename || meta.originalname || '';
  const isVideo = meta.isVideo === 'true' || meta.isVideo === true || (originalName && /\.(mp4|mov|avi|mkv|webm|flv|ogv)$/i.test(originalName));

  // Log incoming metadata for debugging (helps diagnose undefined/path issues)
  try { app.log.debug({ meta, authKey, fileHash, chunkIndex, totalChunks, originalName }, 'upload-chunk metadata'); } catch (e) {}

  if (!users[authKey]) return reply.status(403).send({ error: 'Invalid authKey' });
  if (!chunkBuffer) return reply.status(400).send({ error: 'Missing file chunk' });
  // Defensive validation: reject string 'undefined' or non-finite indices which
  // previously resulted in NaN being written into the manifest as null.
  if (!fileHash || fileHash === 'undefined') return reply.status(400).send({ error: 'Missing or invalid upload id/hash' });
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return reply.status(400).send({ error: 'Invalid chunk index' });
  if (!Number.isFinite(totalChunks) || totalChunks <= 0) return reply.status(400).send({ error: 'Invalid totalChunks' });

  // Use the same chunk filename pattern as the main server (`<uploadId>_chunk_<index>`)
  // so the assembler (which expects that pattern) can find the files.
  const chunkPath = path.join(tmpChunkDir, `${fileHash}_chunk_${chunkIndex}`);
  const manifestPath = path.join(manifestDir, `${fileHash}.json`);

  try { app.log.debug({ chunkPath, manifestPath }, 'Computed chunk & manifest paths'); } catch (e) {}

  try {
    await fsp.writeFile(chunkPath, chunkBuffer);
  } catch (err) {
    try { app.log.error({ err: err && err.message ? err.message : err, chunkPath }, 'Failed writing chunk file'); } catch (e) {}
    return reply.status(500).send({ error: 'Failed to write chunk to disk' });
  }

  let manifest = { received: [], total: Number(totalChunks), originalName, authKey, isVideo };

    if (fs.existsSync(manifestPath)) {
      try {
        const txt = await fsp.readFile(manifestPath, 'utf-8');
        const existing = JSON.parse(txt || '{}');
        // Normalize received entries to numeric indices
        existing.received = Array.isArray(existing.received)
          ? existing.received.map(n => Number(n)).filter(n => Number.isFinite(n))
          : [];
        existing.total = Number(existing.total) || existing.total || manifest.total;
        existing.originalName = existing.originalName || manifest.originalName;
        existing.authKey = existing.authKey || manifest.authKey;
        existing.isVideo = existing.isVideo ?? manifest.isVideo;
        manifest = { ...manifest, ...existing };
      } catch (e) {
        // If manifest JSON is truncated or invalid, log and continue with fresh manifest
        try { console.warn('Failed to read/parse manifest, will overwrite:', manifestPath, e && e.message ? e.message : e); } catch (ee) {}
      }
    }

    if (!manifest.received.includes(Number(chunkIndex))) {
      manifest.received.push(Number(chunkIndex));
      manifest.received.sort((a, b) => a - b);
      // Write manifest atomically to avoid partial/truncated JSON when multiple writers
      const tmpManifest = manifestPath + '.tmp';
      await fsp.writeFile(tmpManifest, JSON.stringify(manifest, null, 2));
      await fsp.rename(tmpManifest, manifestPath);
    }

  if (manifest.received.length === manifest.total) {
      // Validate originalName before calling path.extname (previously caused ERR_INVALID_ARG_TYPE)
      if (!originalName || typeof originalName !== 'string') {
        try { app.log.error({ uploadId: fileHash, manifest }, 'Missing or invalid originalName - aborting assembly'); } catch (e) {}
        return reply.status(400).send({ error: 'Missing original filename for upload' });
      }

  // Reserve a unique final path using the original filename extension
  const reservedPath = getNextFileName(users[authKey], path.extname(originalName), manifest.isVideo);
  const finalPath = reservedPath;

      // Diagnostic: list expected chunk files and sizes before assembling
      let chunkStats = [];
      try {
        for (let i = 0; i < manifest.total; i++) {
          const p = path.join(tmpChunkDir, `${fileHash}_chunk_${i}`);
          try {
            const st = fs.statSync(p);
            chunkStats.push({ index: i, path: p, size: st.size });
          } catch (e) {
            chunkStats.push({ index: i, path: p, exists: false });
          }
        }
        try { app.log.info({ uploadId: fileHash, manifest, chunkStats }, 'Assembling chunks - chunk stats'); } catch (e) {}
      } catch (e) {
        try { app.log.error({ err: e && e.message ? e.message : e, uploadId: fileHash }, 'Failed to compute chunk stats'); } catch (ee) {}
      }

      // If any chunk is missing or zero-sized, abort assembly and keep artifacts for inspection
      const missing = chunkStats.find(s => s.exists === false || s.size === 0);
      if (missing) {
        try { app.log.error({ uploadId: fileHash, missing, chunkStats }, 'Missing/zero chunk - aborting assembly'); } catch (e) {}
        return reply.status(500).send({ error: 'Missing or empty chunk files', missing, chunkStats });
      }

      // Assemble into a temp file first, then atomically rename over the reserved placeholder
      const tmpFinalPath = path.join(path.dirname(finalPath), `.tmp_assemble_${path.basename(finalPath)}_${Date.now()}`);

      try {
        const writeStream = fs.createWriteStream(tmpFinalPath);

        for (let i = 0; i < manifest.total; i++) {
          const chunk = await fsp.readFile(path.join(tmpChunkDir, `${fileHash}_chunk_${i}`));
          writeStream.write(chunk);
        }

        writeStream.end();

        await new Promise((resolve, reject) => {
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });

        // Rename tmp assembled file to the final reserved path
        await fsp.rename(tmpFinalPath, finalPath);

        // Verify integrity
        const fileBuffer = await fsp.readFile(finalPath);
        const bufferStream = Readable.from([fileBuffer]);
        const hash = await getFileHash(bufferStream);
        const duplicate = uploadLog.find(entry => entry.hash === hash && entry.authKey === authKey);

        if (duplicate) {
          await fsp.unlink(finalPath).catch(()=>{});
          return reply.send({ warning: 'Duplicate file skipped' });
        }

        // Record the upload (write atomically)
        uploadLog.push({
          authKey,
          fullName: users[authKey],
          originalName,
          savedName: path.basename(finalPath),
          timestamp: new Date().toISOString(),
          hash
        });

        const tmpLog = `${logFile}.tmp`;
        await fsp.writeFile(tmpLog, JSON.stringify(uploadLog, null, 2));
        await fsp.rename(tmpLog, logFile);

        // Cleanup chunks and manifest
        await Promise.all(Array.from({ length: manifest.total }, (_, i) =>
          fsp.unlink(path.join(tmpChunkDir, `${fileHash}_chunk_${i}`)).catch(()=>{})
        ));
        await fsp.unlink(manifestPath).catch(()=>{});

        return reply.send({ success: true, file: path.basename(finalPath) });
      } catch (err) {
        // Log detailed error for debugging
        try { app.log.error({ err: err && err.stack ? err.stack : err, uploadId: fileHash }, 'Chunk assemble error'); } catch (e) {}
        await fsp.unlink(tmpFinalPath).catch(()=>{});
        await fsp.unlink(finalPath).catch(()=>{});
        return reply.status(500).send({ error: 'Failed to merge file.' });
      }
      
    }
    return reply.send({ success: true, status: 'Chunk received', current: manifest.received.length });
    } catch (err) {
      console.error('upload-chunk handler error:', err && err.stack ? err.stack : err);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
