// server.js
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import crypto from 'crypto';
import csv from 'csv-parser';
import fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { registerChunkRoutes } from './backend/chunkHandler.js';
import { startCleanupService } from './backend/cleanup.js';
import fastifyHelmet from '@fastify/helmet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = '/mnt/ssd/FileUploadServer/uploads';
const authFile = '/mnt/ssd/FileUploadServer/users.csv';
const logFile = '/mnt/ssd/FileUploadServer/upload_log.json';
const tmpUploadDir = path.join(uploadDir, 'tmp');
const chunkDir = path.join(uploadDir, 'tmp_chunks');
const manifestDir = path.join(__dirname, 'manifests');

const ensureDirExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

ensureDirExists(chunkDir);
ensureDirExists(manifestDir);
ensureDirExists(tmpUploadDir)

startCleanupService({
  chunkDir,
  manifestDir,
  mergedDir: path.join(uploadDir, 'merged'),
});

const app = fastify({ logger: true });

// Plugins
await app.register(multipart);
await app.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  setHeaders: (res, path) => {
    if (path.endsWith('.js') || path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
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
      frameAncestors: [//iframe embedding
        "'self'", 
        'https://sites.google.com',
        'https://lh6.googleusercontent.com'
      ]
    }
  }
});

// Helper: Load users into memory
const users = {};
fs.createReadStream(authFile)
  .pipe(csv())
  .on('data', (row) => {
    users[row.AuthKey] = row.FullName;
  })
  .on('end', () => {
    console.log('Users loaded:', Object.keys(users).length);
  });
  
// Helper: Load upload log
let uploadLog = [];
if (fs.existsSync(logFile)) {
  uploadLog = JSON.parse(fs.readFileSync(logFile));
}

const getFileHash = (stream) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  stream.on('data', chunk => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
  stream.on('error', reject);
});

const getNextFileName = (name, ext, isVideo) => {
  const prefix = isVideo ? 'VID' : 'IMG';
  let counter = 0;
  let newPath;
  do {
    const suffix = `${prefix}-${counter.toString().padStart(4, '0')}${ext}`;
    newPath = path.join(uploadDir, `${name}_${suffix}`);
    counter++;
  } while (fs.existsSync(newPath));
  return newPath;
};
const getChunkPath = (uploadId, index) =>
  path.join(chunkDir, `${uploadId}_chunk_${index}`);

const getManifestPath = (uploadId) =>
  path.join(manifestDir, `${uploadId}.json`);

const assembleChunks = async (uploadId, totalChunks, finalPath) => {
  const writeStream = fs.createWriteStream(finalPath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = getChunkPath(uploadId, i);
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Missing chunk #${i}`);
    }

    const readStream = fs.createReadStream(chunkPath);
    await pipeline(readStream, writeStream);
    fs.unlinkSync(chunkPath); // clean up
  }
};

// Get index
app.get('/', async (req, reply) => {
  try {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    let html = await fs.promises.readFile(htmlPath, 'utf-8');

    const authKey = req.query.authKey || '';
    html = html.replace('{{authKey}}', authKey);

    reply.type('text/html').send(html);
  } catch (err) {
    reply.code(500).send('Error loading page: ' + err);
  }
});

// Get status of chunk uploads
app.get('/upload-status', async (req, reply) => {
  const { hash } = req.query;
  if (!hash) return reply.status(400).send({ error: 'Missing file hash' });

  const manifestPath = getManifestPath(hash);
  if (!fs.existsSync(manifestPath)) {
    return reply.send({ received: [] }); // nothing uploaded yet
  }

  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    reply.send({ received: manifest.received || [] });
  } catch (err) {
    reply.status(500).send({ error: 'Failed to read manifest' });
  }
});

// Upload endpoints
app.post('/upload-manifest', async (req, reply) => {
  const parts = req.parts();
  let manifest = null;

  for await (const part of parts) {
    if (part.type === 'field' && part.fieldname === 'manifest') {
      try {
        manifest = JSON.parse(part.value);
      } catch (err) {
        return reply.status(400).send({ error: 'Invalid manifest JSON' });
      }
    }
  }

  if (!manifest || !manifest.uploadId || !manifest.totalChunks || !manifest.filename || !manifest.authKey) {
    return reply.status(400).send({ error: 'Missing manifest fields' });
  }

  const { uploadId, totalChunks, filename, authKey } = manifest;

  if (!users[authKey]) return reply.status(403).send({ error: 'Invalid authKey' });
  const user = users[authKey];
  const ext = path.extname(filename);
  const isVideo = manifest.isVideo;

  const finalPath = getNextFileName(user, ext, isVideo);

  try {
    await assembleChunks(uploadId, totalChunks, finalPath);
    uploadLog.push({
      authKey,
      fullName: user,
      originalName: filename,
      savedName: path.basename(finalPath),
      timestamp: new Date().toISOString(),
      hash: '', // optional: you can compute full file hash here
    });
    fs.writeFileSync(logFile, JSON.stringify(uploadLog, null, 2));
    reply.send({ success: true, savedAs: path.basename(finalPath) });
  } catch (err) {
    reply.status(500).send({ error: 'Assembly failed: ' + err.message });
  }
});
app.post('/upload', async (req, reply) => {
  const parts = req.parts();
  let authKey = null;
  const filesToProcess = [];
  const savedFiles = [];

  // First, collect all parts
  for await (const part of parts) {
    if (part.type === 'field' && part.fieldname === 'authKey') {
      authKey = part.value.trim();
    } else if (part.type === 'file') {
      filesToProcess.push(part);
    }
  }

  if (!authKey) return reply.status(400).send({ error: 'Missing authKey' });
  if (!users[authKey]) return reply.status(403).send({ error: 'Invalid authKey' });

  const user = users[authKey];

  for (const part of filesToProcess) {
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.ogv'];
    const ext = path.extname(part.filename);
    const isVideo = part.mimetype.startsWith('video/') || videoExtensions.includes(ext.toLowerCase());
    const tmpPath = path.join(tmpUploadDir, `${Date.now()}_${part.filename}`);
    const tmpStream = fs.createWriteStream(tmpPath);

    await part.file.pipe(tmpStream);
    await new Promise(r => tmpStream.on('finish', r));

    const fileBuffer = fs.createReadStream(tmpPath);
    const hash = await getFileHash(fileBuffer);

    const alreadyUploaded = uploadLog.find(entry => entry.authKey === authKey && entry.hash === hash);
    if (alreadyUploaded) {
      fs.unlinkSync(tmpPath);
      continue;
    }

    const finalPath = getNextFileName(user, ext, isVideo);
    try
    {
      fs.renameSync(tmpPath, finalPath);
    } catch (err)
    {
      // fallback if rename fails unexpectedly
      fs.copyFileSync(tmpPath, finalPath);
      fs.unlinkSync(tmpPath);
    }

    uploadLog.push({
      authKey,
      fullName: user,
      originalName: part.filename,
      savedName: path.basename(finalPath),
      timestamp: new Date().toISOString(),
      hash
    });
    savedFiles.push(path.basename(finalPath));
  }
    fs.writeFileSync(logFile, JSON.stringify(uploadLog, null, 2));
    reply.send({ success: true, files: savedFiles });
  });

await registerChunkRoutes(app, users, getFileHash, getNextFileName, uploadLog, logFile);

// Launch
app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Server running at ${address}`);
});
