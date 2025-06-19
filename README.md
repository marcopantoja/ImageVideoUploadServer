# File Upload Server

A lightweight, self-hosted Node.js + Fastify web application that allows users to upload photos and videos securely to a Raspberry Pi 5. The server verifies uploads against a pre-approved list of users and supports streaming uploads with real-time progress feedback, duplicate detection via file hashing, and structured file naming.

---

## ✨ Features

- 📂 **Secure Uploads**: Users upload files through a public-facing form routed via a Cloudflare Tunnel.
- 🔐 **Auth-Key Validation**: Each upload is authorized using a key matched against a CSV of allowed users.
- 🧠 **Smart Deduplication**: Prevents repeated uploads by checking file hashes.
- 📸 **Flexible File Handling**: Images and videos stored separately using user-specific naming conventions.
- 🚀 **Fast Streaming**: Files are piped directly to disk, optimized for large uploads.
- 🌐 **Reverse Proxy Access**: Served through `upload.yourdomain.com` without exposing local IP.
- 🖥️ **Runs on Raspberry Pi 5** with SSD storage and PM2 process management.

---

## ⚙️ Authentication Model

Each authorized user is given a unique `authKey` which is mapped to their name in a CSV file (`users.csv`) with the following format:

```
FullName,FirstName,LastName,ShortKey,AuthKey
```

When a user accesses the form via:

```
https://upload.yourdomain.com/?authKey=abc123...
```

The key is embedded into the HTML form dynamically and passed with the upload. The backend verifies this against the CSV and allows or rejects the request.

---

## 🌐 Domain & Routing Setup

- Domain: `upload.yourdomain.com`
- Uses **Cloudflare Tunnel** for public access
- DNS `CNAME` for `upload` subdomain points to `tunnel.cloudflare.com`
- Server listens on `localhost:3000`, tunnel forwards HTTPS traffic securely

---

## 🏗️ Built With

- [Fastify](https://www.fastify.io/) - Web framework for Node.js
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) - Secure, zero-config public access
- [PM2](https://pm2.keymetrics.io/) - Process manager for Node.js
- [csv-parser](https://www.npmjs.com/package/csv-parser) - Lightweight CSV reader for Node.js
- [crypto](https://nodejs.org/api/crypto.html) - Node.js hashing module

---

## 📁 Directory Structure

```
/mnt/ssd/FileUploadServer/
├── server.js                # Fastify backend
├── public/
│   └── index.html           # Upload form
├── uploads/                 # Saved media files
├── users.csv                # List of authorized users
├── upload-log.json          # Track saved files
└── favicon.ico              # Website icon
```

---

## 🚀 Deployment

### 1. Install Dependencies

```bash
npm install @fastify/fastify @fastify/multipart @fastify/static csv-parser
```

### 2. Start the Server with PM2

```bash
pm2 start server.js --name fileupload
pm2 save
pm2 startup
```

### 3. Expose Publicly with Cloudflare Tunnel

```bash
cloudflared tunnel create fileupload
cloudflared tunnel route dns fileupload upload.yourdomain.com
cloudflared tunnel run fileupload
```

Create a `config.yml` to run on boot via systemd.

---

## ✅ Upload Flow

1. User accesses: `upload.yourdomain.com/?authKey=...`
2. AuthKey is injected into the HTML form.
3. Files selected and uploaded via `POST /upload`
4. Backend:
   - Validates authKey
   - Hashes and checks file
   - Saves file and logs it to upload-log.json

---

## 🧩 Customization

- Edit `/public/index.html` for branding/styling
- Customize file naming logic
- Extend logging or add email notifications

---

## 📜 License

MIT License — open and free for personal use and adaptation.