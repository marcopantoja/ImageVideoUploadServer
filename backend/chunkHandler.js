// backend/chunkHandler.js
import decompress from 'decompress';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tmpChunkDir = path.resolve(__dirname, '../uploads/tmp_chunks');
const finalDir = path.resolve(__dirname, '../uploads/merged');
const manifestDir = path.resolve(__dirname, '../manifests');

export async function registerChunkRoutes(app, users, getFileHash, getNextFileName, uploadLog, logFile) {
  // Ensure directories exist
  [tmpChunkDir, finalDir, manifestDir].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

  app.post('/upload-chunk', async (req, reply) => {
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

    const { authKey, fileHash, chunkIndex, totalChunks, originalName, isVideo } = meta;

    if (!users[authKey]) return reply.status(403).send({ error: 'Invalid authKey' });
    if (!chunkBuffer) return reply.status(400).send({ error: 'Missing file chunk' });

    const chunkPath = path.join(tmpChunkDir, `${fileHash}_${chunkIndex}.chunk`);
    await fsp.writeFile(chunkPath, chunkBuffer);

    const manifestPath = path.join(manifestDir, `${fileHash}.json`);
    let manifest = { received: [], total: Number(totalChunks), originalName, authKey, isVideo };

    if (fs.existsSync(manifestPath)) {
      const existing = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      manifest = { ...manifest, ...existing };
    }

    if (!manifest.received.includes(Number(chunkIndex))) {
      manifest.received.push(Number(chunkIndex));
      manifest.received.sort((a, b) => a - b);
      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }

    if (manifest.received.length === manifest.total) {
      const finalFileName = getNextFileName(users[authKey], path.extname(originalName), manifest.isVideo);
      const finalPath = path.join(finalDir, path.basename(finalFileName));
      const writeStream = fs.createWriteStream(finalPath);

      for (let i = 0; i < manifest.total; i++) {
        const chunk = await fsp.readFile(path.join(tmpChunkDir, `${fileHash}_${i}.chunk`));
        writeStream.write(chunk);
      }

      writeStream.end();

      await new Promise(resolve => writeStream.on('finish', resolve));

      // Decompress the file (assumes zip)
      try {
        const extracted = await decompress(finalPath, finalDir);
        const extractedFilePath = extracted[0]?.path ? path.join(finalDir, extracted[0].path) : finalPath;
        // Verify integrity
        const fileBuffer = await fsp.readFile(extractedFilePath);
        const hash = await getFileHash(fileBuffer);
        const duplicate = uploadLog.find(entry => entry.hash === hash && entry.authKey === authKey);
  
        if (duplicate) {
          await fsp.unlink(extractedFilePath);
          return reply.send({ warning: 'Duplicate file skipped' });
        }
  
        // Record the upload
        uploadLog.push({
          authKey,
          fullName: users[authKey],
          originalName,
          savedName: path.basename(extractedFilePath),
          timestamp: new Date().toISOString(),
          hash
        });
  
        await fsp.writeFile(logFile, JSON.stringify(uploadLog, null, 2));
  
        // Cleanup
        await fsp.unlink(finalPath);
        await Promise.all(Array.from({ length: manifest.total }, (_, i) =>
          fsp.unlink(path.join(tmpChunkDir, `${fileHash}_${i}.chunk`))
        ));
        await fsp.unlink(manifestPath);
  
        return reply.send({ success: true, file: path.basename(extractedFilePath) });
      
      } catch (err) {
        await fsp.unlink(finalPath);
        return reply.status(500).send({ error: 'Failed to decompress or merge file.' });
      }
    }
    return reply.send({ success: true, status: 'Chunk received', current: manifest.received.length });
  });
}
