# Velocity

**The first-class storage solution.**

Velocity is a self-hosted file manager. You run it on your own computer or server, and use it from a web browser to browse, upload, download, preview, and share your files.

It runs on Windows and Linux.

## Features

- Accounts with a login. The first account created is the owner.
- Private storage for each user, plus access to external drives.
- Chunked uploads that can resume after an interruption.
- Download files or whole folders as a zip.
- Create, rename, copy, move, and delete files and folders.
- Compress and extract archives.
- Preview images, video, audio, code, and PowerPoint files in the browser.
- Edit text and code files in the browser.
- Share a file or folder with a link, and turn the link off later.
- Live widgets for storage, bandwidth, and network use.
- Progress tracking for long operations like large copies.

## Requirements

- Node.js 20 or newer.
- Build tools for native modules (only needed on Linux). See [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).

Optional tools add extra previews. Velocity runs fine without them, and the startup log tells you which are missing.

| Tool | What it enables |
| --- | --- |
| ffmpeg | Converting .mov files to .mp4 |
| ImageMagick | Previews for .cr3 raw photos |
| exiftool | Fallback preview for .cr3 photos |

## Install and run

1. Install the server dependencies:

   ```sh
   npm install
   ```

2. Build the web client. The server serves the built files from `client/dist`:

   ```sh
   npm --prefix client install
   npm --prefix client run build
   ```

3. Start the server:

   ```sh
   npm start
   ```

4. Open `http://localhost:3000` in your browser.

On first visit you will see a signup page. The account you create there becomes the owner.

## Accounts and permissions

- **Owner.** The first account. The owner can reset passwords, disable or delete accounts, and set each user's external drive access.
- **User.** Every account after the first. Users get their own private storage.
- **Open signup.** After the owner exists, anyone who can reach the server can create an account. New accounts get read-only access to external drives until the owner changes it. If your server is reachable from the internet, keep this in mind.

External drive access has three levels: no access, read only, and read and write.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on. |
| `VELOCITY_SESSION_SECRET` | generated | Key used to sign login sessions. If unset, one is created and saved in `.session-secret`. |
| `VELOCITY_EXTERNAL_DRIVES` | none | Extra folders to treat as external drives, separated by commas. Linux only. |
| `OPERATIONS_DB` | `./operations.db` | Where to store the SQLite database. |
| `NO_COLOR` | none | Turns off colors in the log output. |

## Where your data lives

Everything is stored next to `server.js`.

| Path | Contents |
| --- | --- |
| `content/` | Uploaded files, in one folder per user. |
| `operations.db` | Accounts and long-running operations. |
| `shares.json` | Share links. |
| `.session-secret` | Session signing key. |
| `logs/` | Server logs. |
| `converted/` | Cached previews and conversions. |

These are all excluded from git. Back them up if the data matters to you, and never commit `.session-secret` or `operations.db`.

## Security notes

- **No HTTPS built in.** The server speaks plain HTTP. If you expose it beyond your own network, put it behind a reverse proxy that provides HTTPS, such as Caddy or nginx. Tailscale is another option.
- **Passwords** are hashed with bcrypt and must be at least 8 characters.
- **Share links** work without a login. Anyone who has a link can open what it points to, so only send links to people you trust.
- **Files are not encrypted on disk.** An end-to-end encryption design exists in [E2EE-DESIGN.md](E2EE-DESIGN.md), but it is a draft and is not implemented.

## Development

Run the client with hot reload while the server runs separately:

```sh
npm start
npm --prefix client run dev
```

Lint the client:

```sh
npm --prefix client run lint
```

### Project layout

| Path | Purpose |
| --- | --- |
| `server.js` | Express server, API routes, and WebSocket updates. |
| `db.js`, `user-store.js`, `share-store.js`, `operation-store.js` | Data storage. |
| `operation-runner.js` | Runs long operations like copy and move. |
| `bandwidth.js`, `network-stats.js` | Usage statistics. |
| `size-worker.js`, `space-check.js` | Folder size and free space checks. |
| `logger.js` | Logging. |
| `client/` | React web client, built with Vite. |
| `assets/`, `public/` | Static images and fonts. |

## Deploying on Linux

See [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md) for Node setup, native build tools, external drives, and a systemd service.

## License

MIT. See [LICENSE](LICENSE).
