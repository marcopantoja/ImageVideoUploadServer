// cleanup.js
import fs from 'fs';
import path from 'path';

const HOURS = 24;
const MS_THRESHOLD = HOURS * 60 * 60 * 1000;

export async function startCleanupService({
  chunkDir,
  manifestDir,
  mergedDir,
  intervalMinutes = 60,
}) {
  setInterval(() => {
    try {
      const now = Date.now();

      // Clean chunk files
      for (const file of fs.readdirSync(chunkDir)) {
        const filePath = path.join(chunkDir, file);
        const { mtimeMs } = fs.statSync(filePath);
        if (now - mtimeMs > MS_THRESHOLD) {
          fs.unlinkSync(filePath);
          console.log(`Removed stale chunk: ${file}`);
        }
      }

      // Clean manifest files
      for (const file of fs.readdirSync(manifestDir)) {
        const filePath = path.join(manifestDir, file);
        const { mtimeMs } = fs.statSync(filePath);
        if (now - mtimeMs > MS_THRESHOLD) {
          fs.unlinkSync(filePath);
          console.log(`Removed stale manifest: ${file}`);
        }
      }

      // Clean partial .zip files
      for (const file of fs.readdirSync(mergedDir)) {
        if (!file.endsWith('.zip')) continue;
        const filePath = path.join(mergedDir, file);
        const { mtimeMs } = fs.statSync(filePath);
        if (now - mtimeMs > MS_THRESHOLD) {
          fs.unlinkSync(filePath);
          console.log(`Removed stale zip: ${file}`);
        }
      }

    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }, intervalMinutes * 60 * 1000); // default: every 60 minutes
}
