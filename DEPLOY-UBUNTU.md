# Running velocity on Ubuntu

> The quickest route is [`install.sh`](install.sh) (see the README), which does
> everything on this page for you. Read on to set it up by hand.

The server is portable Node and runs on Ubuntu. Two things need attention before
it will start, and a third before external drives appear.

## 1. Node 20 or newer

`apt install nodejs` on Ubuntu 24.04 gives you Node **18**, which
`better-sqlite3@12` does not support — the install fails while compiling. Use
NodeSource or nvm:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

`package.json` declares `"engines": { "node": ">=20" }`, so npm will warn you
rather than leave you to decode a build error.

## 2. Build tools for the native modules

`diskusage` compiles from source — there are no prebuilt Linux binaries — so the
toolchain has to be present:

```sh
sudo apt install -y build-essential python3
```

`bcrypt`, `better-sqlite3` and `sharp` all ship prebuilt linux-x64 binaries and
need no compiler.

**Do not copy `node_modules/` over from Windows.** The native modules in it are
Windows binaries. Install fresh on the target:

```sh
npm install
npm --prefix client install && npm --prefix client run build
```

The second line matters: the server serves the built SPA from `client/dist`, and
that directory is not produced by the root install.

## 3. Optional conversion tools

These are optional. Without them the server runs normally; only the matching
preview feature goes quiet, and the boot log says which ones are missing:

```sh
sudo apt install -y ffmpeg imagemagick libimage-exiftool-perl
```

| Tool | Enables |
| --- | --- |
| `ffmpeg` | `.mov` → `.mp4` transcoding |
| ImageMagick | `.cr3` (raw photo) preview generation |
| `exiftool` | `.cr3` fallback, extracting the embedded preview |

Ubuntu's `imagemagick` package is **ImageMagick 6**, whose CLI is `convert`, not
`magick`. The server probes for both and uses whichever exists, so either
version works. With ImageMagick absent entirely, CR3 files still get a preview
via the exiftool-extracted JPEG — just without the auto-orient step.

## External drives

On Windows the server enumerates drive letters. On Linux there are none, so it
reads `/proc/mounts` and offers block-device mounts found at or under:

- `/media/<user>/<label>` and `/run/media/<user>/<label>` — where udisks2, the
  desktop automounter, puts removable media
- `/mnt` — the conventional place for a manually mounted disk

Everything else is treated as part of the OS and is never listed: the root
filesystem, `/boot/efi`, snap loop mounts, docker overlays, pseudo-filesystems,
and network shares (NFS/CIFS, which the Windows side excludes too). The volume
holding `content/` is also excluded, the same way `C:` is on Windows.

**A headless server usually automounts nothing.** Mount the disk yourself
(`/etc/fstab` with `nofail`) somewhere under `/mnt`, or point the server at
another location:

```sh
VELOCITY_EXTERNAL_DRIVES=/srv/media,/data
```

Mount points listed there are scanned in addition to the defaults.

The account running the server needs read (and, for a writable drive, write)
access to the mount. udisks2 mounts removable media as the desktop user, so a
service account will not automatically be able to read it — mount with suitable
`uid`/`gid` options, or add the service account to the owning group.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. |
| `VELOCITY_HOST` | all interfaces | Listen address; `127.0.0.1` behind a same-host reverse proxy. |
| `VELOCITY_DATA_DIR` | next to `server.js` | Where files, the database, share links and logs live. |
| `VELOCITY_SIGNUP` | `closed` | `open` lets anyone who can reach the server create an account. |
| `VELOCITY_TRUST_PROXY` | `loopback` | Proxies allowed to set `X-Forwarded-*` (Express `trust proxy` syntax). Set it when the proxy is on another machine. |
| `VELOCITY_SECURE_COOKIES` | `auto` | Secure login cookie: `auto` (when the request was HTTPS), `true` or `false`. |
| `VELOCITY_SESSION_SECRET` | generated | Session signing key. Set this if the app runs on more than one host, or set nothing and let it persist `.session-secret` in the data folder. |
| `VELOCITY_EXTERNAL_DRIVES` | — | Extra mount roots to scan, comma-separated. |
| `OPERATIONS_DB` | `<data dir>/operations.db` | Path to the SQLite database (accounts, sessions, operations). |
| `VELOCITY_LOG_MAX_SIZE_MB` / `VELOCITY_LOG_MAX_FILES` | `20` / `5` | Log rotation: size per file, and rolled-over files kept. |
| `NO_COLOR` / `VELOCITY_NO_COLOR` | — | Disable ANSI colour in the log (useful under `journalctl`). |

An unexpected error (a bug, not a failed file operation) makes the server shut
down cleanly and exit with a failure code; `Restart=on-failure` below brings it
straight back.

## Running under systemd

`SIGTERM` is already handled, so `systemctl stop` shuts down cleanly rather than
being killed after a timeout.

```ini
# /etc/systemd/system/velocity.service
[Unit]
Description=velocity
After=network.target

[Service]
Type=simple
User=velocity
WorkingDirectory=/opt/velocity
ExecStart=/usr/bin/node /opt/velocity/server.js
Environment=NODE_ENV=production
Environment=VELOCITY_NO_COLOR=1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Logs go to `logs/` next to `server.js` regardless of `WorkingDirectory`, and to
the journal.

## Things that behave differently on Linux

Neither is a fault, but both are worth knowing:

- **Filenames are case-sensitive.** `Report.pdf` and `report.pdf` can coexist in
  one folder on Linux where Windows would have treated the second as a
  replacement for the first.
- **Uploaded names are still sanitised to Windows rules** — no `< > : " | ? *`,
  no trailing dots, no `CON`/`NUL`/`COM1`. That is deliberate and was left
  alone: it keeps a file that is copied onto an NTFS or exFAT drive, or synced
  to a Windows machine, from becoming unreadable there.
