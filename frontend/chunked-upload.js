// frontend/chunked-upload.js
import { zipSync } from 'fflate';

const MAX_CHUNK_SIZE = 80 * 1024 * 1024;

export async function prepareChunks(files) {
  const queue = [];

  for (const file of files) {
    const id = crypto.randomUUID();
    const zipBlob = await zipSingleFile(file);
    const chunks = sliceFile(zipBlob, MAX_CHUNK_SIZE);
    const hash = await getHash(zipBlob);
    const preview = await getThumbnail(file);

    queue.push({ id, file, chunks, hash, preview });
  }

  return queue;
}

async function zipSingleFile(file) {
  const zipped = {};
  const buf = await file.arrayBuffer();
  zipped[file.name] = new Uint8Array(buf);
  const zipData = zipSync(zipped);
  return new Blob([zipData], { type: 'application/zip' });
}

function sliceFile(blob, chunkSize) {
  const chunks = [];
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    chunks.push(blob.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function getHash(blob) {
  const buf = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getThumbnail(file) {
  return new Promise(resolve => {
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    } else {
      resolve("/favicon-32x32.png");
    }
  });
}
