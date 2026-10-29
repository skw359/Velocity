# Velocity

[![CI](https://github.com/skw359/Velocity/actions/workflows/ci.yml/badge.svg)](https://github.com/skw359/Velocity/actions/workflows/ci.yml)

**The first-class storage solution.**

Velocity is a self-hosted file manager. You run it on your own computer or server, and use it from a web browser to browse, upload, download, preview, and share your files.

It runs on Windows and Linux.

<img width="1280" height="656" alt="iuehwsrfjowieiuhfwfe" src="https://github.com/user-attachments/assets/23db06c2-9a8e-431f-a581-fa47804515f0" />


## Features

- Accounts with a login. The first account created is the owner, who adds the others.
- Private storage for each user, plus access to external drives.
- Chunked uploads that can resume after an interruption, verified byte for byte.
- Download files or whole folders as a zip.
- Create, rename, copy, move, and delete files and folders.
- Compress and extract archives.
- Preview images, video, audio, PDFs, and code in the browser.
- Edit text and code files in the browser.
- Share a file or folder with a link, and turn the link off later.
- Live widgets for storage, bandwidth, and network use.
- Progress tracking for long operations like large copies.

## Requirements

- Node.js 22.12 or newer. (Node 20 has reached end of life, and the SQLite driver no longer ships binaries for it.)
- No compiler for the usual platforms: every native module ships prebuilt binaries. Build tools are only a fallback for unusual systems; see [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md).

Optional tools add extra previews. Velocity runs fine without them, and the startup log tells you which are missing.

| Tool | What it enables |
| --- | --- |
| ffmpeg | Converting .mov files to .mp4 |
| ImageMagick | Previews for .cr3 raw photos |
| exiftool | Fallback preview for .cr3 photos |

## Install and run

### Linux installer

On a Linux system that uses systemd (Ubuntu, Debian, Fedora, Arch, openSUSE and their relatives), one command installs Velocity as a service that starts on boot:

```sh
curl -fsSL https://raw.githubusercontent.com/skw359/Velocity/main/install.sh | sudo bash
```

From a checkout, run `sudo bash install.sh` instead. The installer asks a few questions: the port, whether to add the optional preview tools, whether to open the port in the firewall, and the owner account. Then it does the rest. It installs the build tools and its own copy of Node.js, builds the web client, creates a `velocity` service account and the systemd service, and prints the address to open.

- Run it again to update. Your settings, accounts and files are kept.
- `--uninstall` removes the service. It asks before deleting any data.
- `--yes` accepts every default, for unattended installs. `--help` lists the other options.

For a step-by-step guide, including backups, settings and troubleshooting, see [INSTALL.md](INSTALL.md).

### By hand

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

- **Owner.** The first account. The owner adds accounts, resets passwords, disables or deletes accounts, and sets each user's external drive access, all under **Settings → People**.
- **User.** Every account after the first. Users get their own private storage.
- **Sign-up is closed** once the owner exists: only the owner can add accounts. To let anyone who can reach the server create their own account, set `VELOCITY_SIGNUP=open`. Self-created accounts get read-only access to external drives until the owner changes it.

External drive access has three levels: no access, read only, and read and write.

Changing a password signs that account out everywhere else, and an owner's password reset or suspension signs the account out on every device.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on. |
| `VELOCITY_HOST` | all interfaces | Address to listen on. Set `127.0.0.1` when a reverse proxy on the same machine provides HTTPS, so the plain-HTTP port isn't exposed. |
| `VELOCITY_DATA_DIR` | next to `server.js` | Folder holding all data: files, database, share links, logs. |
| `VELOCITY_SIGNUP` | `closed` | `open` lets anyone who can reach the server create an account. Otherwise only the owner adds accounts. |
| `VELOCITY_TRUST_PROXY` | `loopback` | Which proxies may set `X-Forwarded-For`/`-Proto` (Express `trust proxy` syntax). The default trusts only a proxy on this machine. Set it if your proxy runs elsewhere, for example `10.0.0.5`. |
| `VELOCITY_SECURE_COOKIES` | `auto` | `auto` marks the login cookie Secure whenever the request arrived over HTTPS. `true` forces it, `false` never sets it. |
| `VELOCITY_SESSION_SECRET` | generated | Key used to sign login sessions. If unset, one is created and saved in `.session-secret`. |
| `VELOCITY_EXTERNAL_DRIVES` | none | Extra folders to treat as external drives, separated by commas. Linux only. |
| `OPERATIONS_DB` | `<data dir>/operations.db` | Where to store the SQLite database. |
| `VELOCITY_LOG_DIR` | `<data dir>/logs` | Where log files are written. |
| `VELOCITY_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`; `silent` turns logging off. |
| `VELOCITY_LOG_MAX_SIZE_MB` | `20` | Size at which a log file rolls over. |
| `VELOCITY_LOG_MAX_FILES` | `5` | Rolled-over files kept per log; older ones are deleted. |
| `NO_COLOR` | none | Turns off colors in the log output. |

## Where your data lives

Everything is stored next to `server.js` unless `VELOCITY_DATA_DIR` says otherwise. The Linux installer puts it in `/opt/velocity/app`.

| Path | Contents |
| --- | --- |
| `content/` | Uploaded files, in one folder per user. Each user's `cache/` folder holds their thumbnails and previews. |
| `operations.db` | Accounts, login sessions, and long-running operations. |
| `shares.json` | Share links. |
| `.session-secret` | Session signing key. |
| `logs/` | Server logs. Each file rolls over at 20 MB and five are kept (see Configuration). |

These are all excluded from git. Back them up if the data matters to you, and never commit `.session-secret` or `operations.db`.

## Security notes

- **No HTTPS built in.** The server speaks plain HTTP. If you expose it beyond your own network, put it behind a reverse proxy that provides HTTPS, such as Caddy or nginx, and set `VELOCITY_HOST=127.0.0.1` so only the proxy can reach it. Tailscale is another option. With HTTPS in front, the login cookie is marked Secure and browsers are told to stay on HTTPS.
- **Passwords** are hashed with bcrypt and must be at least 8 characters. Repeated failed sign-ins from one address are slowed down.
- **Share links** work without a login. Anyone who has a link can open what it points to, so only send links to people you trust.
- **Uploaded web pages don't run.** HTML, SVG and other files a browser could execute are served as downloads, with a policy that blocks scripts, so a shared or uploaded file can't act as the people who open it.
- **Requests from other sites are refused.** Changes must come from Velocity's own pages, so another website (or another service on the same machine) can't act through a signed-in browser.
- **Files are not encrypted on disk.** An end-to-end encryption design exists in [E2EE-DESIGN.md](E2EE-DESIGN.md), but it is a draft and is not implemented.

## Development

Run the client with hot reload while the server runs separately:

```sh
npm start
npm --prefix client run dev
```

Run the server tests (each test file gets its own temporary data folder and port, so they never touch real data), and lint the client:

```sh
npm test
npm --prefix client run lint
```

`npm test -- upload` runs only the test files whose names contain "upload".

### Project layout

| Path | Purpose |
| --- | --- |
| `server.js` | Entry point: starts the server, handles signals and fatal errors. |
| `app.js` | Assembles the Express app, the routes, and the search WebSocket. |
| `routes/` | HTTP routes: sign-in, files, uploads, operations, shares, accounts. |
| `config.js` | Settings from environment variables, and where data lives. |
| `auth.js`, `session-store.js`, `security.js` | Sessions and login guards, the session database, security headers and cross-site checks. |
| `paths.js`, `drives.js` | Path safety rules, storage roots and drive access. |
| `user-content.js` | How uploaded files are served (inline or as a download). |
| `archive-extract.js` | Safe zip and tar.gz extraction. |
| `media.js` | Video and raw photo previews (ffmpeg, ImageMagick, ExifTool). |
| `search.js` | Search over the WebSocket. |
| `db.js`, `user-store.js`, `share-store.js`, `operation-store.js` | Data storage. |
| `operation-runner.js` | Runs long operations like copy and move, and resumes them after a crash. |
| `dir-size.js`, `size-worker.js`, `space-check.js` | Folder sizes and free space checks. |
| `bandwidth.js`, `network-stats.js` | Usage statistics. |
| `logger.js`, `process-guard.js` | Logging, and what happens to an unexpected error. |
| `tests/` | Server tests (`npm test`). |
| `client/` | React web client, built with Vite. |
| `assets/`, `public/` | Static images and fonts. |

## Deploying on Linux

The [Linux installer](#linux-installer) sets everything up, and [INSTALL.md](INSTALL.md) walks through it step by step. To do it by hand instead, see [DEPLOY-UBUNTU.md](DEPLOY-UBUNTU.md) for Node setup, native build tools, external drives, and a systemd service.

## License

MIT. See [LICENSE](LICENSE).
