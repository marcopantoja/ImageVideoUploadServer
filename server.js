// server.js
import fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = '/mnt/ssd/FileUploadServer/uploads';
const authFile = '/mnt/ssd/FileUploadServer/users.csv';
const logFile = '/mnt/ssd/FileUploadServer/upload_log.json';

const app = fastify({ logger: true });

// Plugins
await app.register(multipart);
await app.register(staticPlugin, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
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

// Get index
app.get('/', async (req, reply) => {
  const fs = require('fs').promises;
  const path = require('path');

  try
  {
    const htmlPath = path.join(__dirname, 'index.html');
    let html = await fs.readFile(htmlPath, 'utf-8');

    const authKey = req.query.authKey || '';
    html = html.replace('{{authKey}}', authKey);

    reply.type('text/html').send(html);
  }
  catch (err)
  {
    reply.code(500).send('Error loading page: '+err)
  }
});

// Upload endpoint
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
    const tmpPath = path.join('/tmp', `${Date.now()}_${part.filename}`);
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
    fs.renameSync(tmpPath, finalPath);

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

// Launch
app.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`Server running at ${address}`);
});
