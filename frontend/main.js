import { prepareChunks } from './chunked-upload.js';

const MAX_WORKERS = 4;
let paused = false;
let uploadQueue = [];
const fileInput = document.getElementById("fileUpload");
const uploadButton = document.getElementById("uploadButton");
const pauseButton = document.getElementById("pauseButton");
const resumeButton = document.getElementById("resumeButton");
const uploadList = document.getElementById("uploadList");
const authKey = document.getElementById("authKey")?.value.trim();

fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  uploadList.innerHTML = "";
  const { chunks, manifest } = await prepareChunks(files);
  const id = manifest.sha256;
  uploadQueue = [{ id, file: files[0], chunks, manifest, uploaded: new Set() }];

  for (const task of uploadQueue) {
    const entry = document.createElement("div");
    entry.classList.add("progress-container");
    entry.innerHTML = `
      <div class="progress-thumb">
        <img src="" class="thumb" alt="" />
        <div class="progress-bar" id="bar-${task.id}">Waiting...</div>
      </div>
    `;
    uploadList.appendChild(entry);
  }
});
uploadButton.addEventListener("click", async () => {
  if (!authKey || uploadQueue.length === 0) return;
  paused = false;
  uploadButton.disabled = true;
  uploadButton.style.display = "none";
  [pauseButton, resumeButton].forEach(button => {
    button.style.display = "block";
  });

  const pool = Array(MAX_WORKERS).fill(null);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < uploadQueue.length) {
      if (paused) return;
      const task = uploadQueue[nextIndex++];
      const bar = document.getElementById(`bar-${task.id}`);
      const status = await fetch(`/upload-status?hash=${task.manifest.sha256}`).then(r => r.json());
      const received = new Set(status.received || []);

      for (let j = 0; j < task.chunks.length; j++) {
        if (paused) return;
        if (received.has(j)) continue;

        const formData = new FormData();
        formData.append("authKey", authKey);
        formData.append("fileHash", task.manifest.sha256);
        formData.append("chunkIndex", j);
        formData.append("totalChunks", task.chunks.length);
        formData.append("originalName", task.file.name);
        formData.append("isVideo", task.file.type.startsWith("video") ? "true" : "false");
        formData.append("chunk", task.chunks[j]);

        let retries = 0;
        while (retries < 3) {
          try {
            const res = await fetch("/upload-chunk", { method: "POST", body: formData });
            if (!res.ok) throw new Error("Chunk upload failed");
            break;
          } catch (e) {
            retries++;
          }
        }

        const percent = Math.round(((j + 1 + received.size) / task.chunks.length) * 100);
        bar.style.width = `${percent}%`;
        bar.textContent = `${task.file.name} — ${percent}%`;
      }
    }
  }

  await Promise.all(pool.map(() => worker()));
  uploadButton.disabled = false;
  if (!paused)
  {
    uploadButton.style.display = "block";
    [pauseButton,resumeButton].forEach(button => {
      button.style.display = "none";
    });
  }
});
pauseButton.addEventListener("click", () => {
  paused = true;
});
resumeButton.addEventListener("click", () => {
  if (paused) uploadButton.click();
});
