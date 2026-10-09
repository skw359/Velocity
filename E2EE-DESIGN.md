# Velocity E2EE Design

**Status:** draft for review · **Scope decision required:** see §13
**Companion:** audit appendix in §14 (generated from full-codebase review)

---

## 1. Goal, non-goals, and what E2EE actually buys here

**Goal.** Files stored under Velocity's management are ciphertext on disk. The server
(Node process, the Windows box it runs on, any backup of `content/`) can never read file
*contents*. All encryption and decryption happens in the browser with keys derived from
the login password. Every current feature either survives, moves client-side, or is
consciously dropped — no silent breakage.

**What it protects against**
- Theft/seizure of the machine or disk; any copy/backup/sync of `content/` (contents unreadable).
- Anything on the box that reads files at rest (other users, curious software, a
  compromised *storage* path).
- A future move of `content/` onto hardware you don't control (cloud VM, friend's NAS,
  object storage): the host learns nothing about contents.

**What it does NOT protect against (stated honestly, not fixable by this design)**
1. **An actively malicious server.** The server serves the JavaScript that does the
   crypto (`client/dist`). Whoever controls the server can ship JS that leaks keys. This
   is the accepted limitation of every browser E2EE product (Proton, MEGA, Filen).
   Mitigation later: a pinned desktop shell (Tauri/Electron) that carries its own client
   build and only talks to the API.
2. **A compromised browser/endpoint.**
3. **Metadata** (phase 1): filenames, tree shape, sizes (±small overhead), mtimes, and
   access patterns remain visible. §12 lists residual leaks; filename encryption is an
   optional later phase (§13).
4. **Ransomware/deletion.** Ciphertext can still be encrypted-again or destroyed. Backups
   remain the answer (and backups of ciphertext are now safe to put anywhere).

**Hard prerequisite: TLS.** `crypto.subtle` and Service Workers only exist in secure
contexts — HTTPS or `localhost`. Today the server is plain HTTP on `:3000`
(`server.js:29`), so on LAN the browser will literally not expose WebCrypto. Options for
a Windows LAN box, in order of preference:
- **Caddy sidecar** reverse-proxying `:443 → :3000` with its internal CA (`caddy trust`
  installs the root cert on your devices), or
- **Tailscale Serve** (`tailscale serve 3000`) — real certs, zero config, remote access
  solved too, or
- self-signed cert imported on each device.

While at it (independent of E2EE, but pointless to skip): session secret from env instead
of `'secret123'` (`server.js:551`), actually `app.use(helmet())` (it's in package.json,
never required), and cookie `secure: true`.

---

## 2. Scope: encryption is a property of the FILE, not the drive

**Any `.vlt` file is encrypted, wherever it sits. The internal drive (`content/`) is
where new uploads get encrypted by default.**

The first draft said "internal drive = vault, external drives = plaintext" — the audit
killed that framing: server-side cross-drive copy/move (`/api/transfer`,
`operation-runner.js`) moves bytes as-is and *cannot* convert in either direction (no
keys). A drive-scoped vault is incoherent the moment a file crosses the boundary. The
per-file framing makes every case well-defined:

- **Uploads to `internal`** are always encrypted client-side (`name.vlt`).
- **Uploads to external drives**: user-facing toggle, default *unencrypted* (removable
  media is usually for interchange), remembered per drive.
- **Transfers** move ciphertext as ciphertext and plaintext as plaintext — always
  correct, never lossy. A `.vlt` on a USB stick simply stays encrypted (readable through
  Velocity anywhere, unreadable to the world — a feature; the UI badges it). A
  deliberate "decrypt on export" action = client-side download-decrypt-rewrite.
- **Foreign files** (anything without the `.vlt` suffix, e.g. dropped into `content/`
  out-of-band or living on a USB drive) are browsable/previewable via the existing
  plaintext paths, badged, with a one-click "encrypt this" (same machinery as migration,
  §9). The old server-side thumbnail/preview endpoints remain in service *for foreign
  files only*.
- `content/cache/` (plaintext thumbnails + transcodes) and the legacy `converted/` dir
  are **purged at migration**; the transcode queue is retired. Keeping decrypted
  derivatives next to ciphertext would defeat the point.

---

## 3. Cryptography

### 3.1 Key hierarchy

```
password ──Argon2id(salt_root, m=64MiB, t=3, p=1)──► rootKey (32B, in-memory only)
                                                        │
                    ┌───────────────HKDF-SHA256─────────┤
                    ▼                                   ▼
            authKey = HKDF(rootKey,"velocity/auth")   KEK = HKDF(rootKey,"velocity/kek")
            (sent to server at login;                 (never leaves the browser)
             server stores bcrypt(authKey))             │
                                                        ▼ AES-256-GCM unwrap
                                        MK  — 256-bit random master key
                                                        │
                                                        ▼ AES-256-GCM unwrap (per file)
                                        FK  — 256-bit random per-file key
                                            (wrapped copy lives in the file's header;
                                             sidecar files carry their own FK, §3.3)
```

- **Login rework.** The browser never sends the password. `LoginPage` fetches salts +
  KDF params (`GET /api/keyring/public`, unauthenticated — salts aren't secret), derives
  `rootKey` (Argon2id via `hash-wasm`, ~0.3–0.8 s on desktop), sends `authKey` where the
  password used to go. Server-side nothing changes except `PASSWORD_HASH` now hashes
  `authKey` instead of the raw password. Session handling (express-session cookie) is
  untouched.
- **Keyring blob** (server-stored, `keyring.json` or a table in `operations.db`):
  `{version, salt_root, argonParams, wrappedMK, salt_rec, wrappedMK_rec, createdAt}`.
  `GET /api/keyring` (authed) returns it; `PUT` requires a fresh authKey proof.
- **Recovery code.** Generated once at vault setup (32 random bytes, shown as 8 groups of
  Crockford base32, printed/saved by the user). `wrappedMK_rec = AES-GCM(Argon2id(code,
  salt_rec), MK)`. Forgot password ⇒ enter recovery code ⇒ unwrap MK ⇒ set new password
  (re-derive, re-wrap). **No code + no password = data is gone.** The setup UI must make
  the user acknowledge this; it is the defining UX contract of E2EE.
- **Password change** = unwrap MK with old KEK, re-wrap with new KEK, replace bcrypt
  hash. No file re-encryption ever needed.
- **Unlock state.** MK lives in page + Service Worker memory only. Optional
  "remember unlock on this device": MK wrapped under a non-extractable per-device AES key
  kept in IndexedDB — protects against casual disk reading, not local malware; off by
  default.

### 3.2 The `.vlt` container format

One encrypted file on disk per user file. Stored name = original name + `.vlt`
(`photo.jpg` → `photo.jpg.vlt`). Names stay plaintext in phase 1 (§13 for the encrypted-
names option); the suffix guarantees no server-side code ever pattern-matches a vault
file into plaintext behavior (the `.mov`/`.cr3` transcode trigger at `server.js:295`,
compress-exclusion lists, searchable-extension lists all naturally miss).

```
offset 0                                                    512
┌──────────────────────────────────────────────────────────┐
│ HEADER (fixed 512 B, plaintext but tamper-evident)       │
│  0-3   magic "VLT1"        4 version=1     5 alg=1 (GCM) │
│  8-11  blockSize (1 MiB)  12-19 plaintextSize (u64 LE)   │
│  20-35 fileId (16 B random)                              │
│  36-43 noncePrefix (8 B random)                          │
│  44-103 wrappedFK = 12B nonce ‖ AES-GCM(MK, FK,          │
│                     aad="VLT1-FK"‖fileId) ‖ 16B tag      │
│  104-511 zero padding (future fields)                    │
├──────────────────────────────────────────────────────────┤
│ BLOCK 0  = AES-256-GCM(FK) of plaintext[0 .. 1MiB)       │
│            ciphertext ‖ 16 B tag   → 1,048,592 B         │
│  nonce   = noncePrefix ‖ u32BE(blockIndex)               │
│  aad     = SHA-256(header[0..512]) ‖ u32BE(blockIndex)   │
├──────────────────────────────────────────────────────────┤
│ BLOCK 1 …                                                │
│ BLOCK N-1 (short final block: len%1MiB + 16 B)           │
└──────────────────────────────────────────────────────────┘
```

Properties, each earned by a specific field:
- **Random access with integrity.** Any block decrypts + authenticates independently
  (this is what makes video scrubbing work). GCM tag catches corruption per block.
- **No reordering/splicing:** blockIndex in nonce *and* AAD. **No cross-file block
  swaps:** FK is unique per file. **No header tampering** (e.g. lying about
  plaintextSize): header hash in every block's AAD — change a byte of the header and
  every block fails auth. **No truncation:** plaintextSize pins the exact block count
  and final-block length. Zero-byte files still get 1 empty block (16 B tag) so even
  they authenticate.
- **Nonce safety without storing nonces:** deterministic `prefix‖counter` is safe because
  FK is single-use — a file's bytes are immutable under a given FK. Any content change
  (editor save, re-upload of a modified file) allocates a **new FK**. This rule is
  load-bearing; the upload pipeline enforces it (§4).
- **Sizes are invertible without reading the file.** ct = 512 + pt + 16·max(1,⌈pt/1MiB⌉).
  Given ciphertext size from `stat` (what `/api/list` already returns):
  `body = ct−512; n = ⌈body/1048592⌉; pt = body − 16n`. The client shows *true* plaintext
  sizes everywhere (list, info, sort, storage math) with zero extra requests, and
  `/api/list`, `/api/get-size`, `/api/info` need no server changes.
- Overhead: 512 B + 16 B/MiB ≈ **0.0018%** — irrelevant.

Why not one-shot AES-GCM over the whole file: no random access, no streaming decrypt, a
single flipped bit fails the entire file, and WebCrypto's non-streaming `encrypt()` would
need the whole file in RAM. Why not AES-CTR+HMAC: GCM gets hardware acceleration and
one-call AEAD in WebCrypto. 1 MiB blocks: fine seek granularity (a seek costs ≤1 MiB of
ciphertext fetch) while keeping per-block call overhead negligible; and **10 blocks pack
exactly into the existing 10 MiB transport chunk** minus bookkeeping (§4).

### 3.3 Companions (thumbnails and other derivatives)

A vault file `photo.jpg.vlt` may have a **companion** `.photo.jpg.vlt.thumb` — same
directory, dot-prefixed (so `/api/list` already hides it, `server.js:760`), containing a
≤256 px JPEG generated **client-side at upload**. A companion is a completely ordinary
container (§3.2) with **its own random FK wrapped under MK** — no special key
derivation, so every read path (including the Service Worker) handles it with zero
special-casing.

Why sibling-file naming instead of a `.vthumb/<fileId>` directory (first draft): the
audit showed server-side rename/move/copy/delete know nothing about a fileId index and
would orphan or leak dot-dir entries. With the sibling convention one **~20-line
companion rule in `operation-runner.js`** keeps them attached: after a successful
rename/move/copy/duplicate/delete of `X`, apply the same operation to `.X.thumb` if it
exists (best-effort, never fails the main op). Two consequences to handle:

- `getDirectoryStats` (`server.js:1440`) and `size-worker.js` walk *everything*; both
  skip names matching `^\..*\.thumb$` so folder sizes/counts don't drift.
- A companion missing for any reason degrades to the generic icon and the client
  **lazily backfills** (fetch → decrypt → downscale → re-encrypt → upload once).

---

## 4. Write path (uploads, editor, create-file)

`useUpload.js` gains an encryption stage; **the server upload path does not change at
all.** The trick: encrypt into a *ciphertext stream* (header + blocks), then slice that
stream into the existing exact-10 MiB transport chunks. All of the server's offset math
(`chunkIndex * CHUNK_SIZE` positional writes, `server.js:1020`; `/upload-offset` resume,
`server.js:1420`) keeps working verbatim because it only ever sees ciphertext bytes.

Per file:
1. Generate FK, fileId, noncePrefix; build header; `x-file-name`/`x-relative-path` get
   the `.vlt` suffix; `x-total-file-size` = **ciphertext** size (computable up front).
2. Read the File in 1 MiB slices → `crypto.subtle.encrypt` (4–6 blocks in flight —
   WebCrypto is async and hardware-backed, ~1–3 GB/s; the LAN, not AES, is the
   bottleneck) → append to a rolling buffer → emit exact 10 MiB chunks through the
   existing `sendChunk()` with its retry loop.
3. For images/videos, generate the thumbnail sidecar (§5.3) and queue it as one extra
   tiny upload.
4. Progress UI converts ciphertext bytes back to plaintext for display (invertible math).

**Resume rules (the one place correctness is subtle).** GCM's fatal failure mode is
reusing (FK, nonce) with *different* plaintext, and resume is exactly where that could
happen. Enforcement:
- Per pending upload, persist in IndexedDB: `{opId, relPath, fileId, FK wrapped under
  MK, header (the exact 512 bytes), fingerprint = (size, lastModified)}`.
  **Persisting the exact header bytes is mandatory**, not an optimization: the header
  contains `wrappedFK`, whose AES-GCM wrap used a random nonce. A resumer that only kept
  FK cannot rebuild a byte-identical header, and since every block's AAD includes
  SHA-256(header), *every block written after resume would fail authentication later*.
  (Belt-and-braces: on resume, ranged-GET bytes 0–511 from the server and assert they
  equal the persisted header before continuing.)
- On resume: `/upload-offset` gives the ciphertext offset; if the file's fingerprint
  matches, re-derive the ciphertext stream with the **same FK and persisted header** —
  identical plaintext ⇒ identical bytes ⇒ overwriting the boundary chunk is
  byte-identical and safe. Transport chunks don't align to cipher blocks (chunk 0 starts
  with the 512 B header), so the simple, always-correct resume is: regenerate the
  ciphertext stream from byte 0 and **discard output** until the resume offset —
  CPU-only at GB/s, no network; ~seconds even for very large files. (A seek-style
  optimization can come later; correctness first.)
- Fingerprint mismatch (file was modified since) ⇒ **fresh FK, restart at chunk 0** —
  the server's `'w'` flag on chunk 0 truncates (`server.js:1020`), so no stale blocks
  survive.
- Zero-byte files: header + 1 empty block = 528 B, single chunk; the server's existing
  empty-file special case in `useUpload.js:74` folds into the normal path.

**Text editor.** `PreviewModal`'s save currently POSTs plaintext JSON to `/api/save-file`
(`server.js:1298`). Under E2EE: an edit = new content ⇒ **new FK** ⇒ re-encrypt the whole
buffer and write through the normal chunk path (chunk 0 truncates; a text file is almost
always 1 chunk). `/api/save-file` is disabled for vault paths. Read side in §5.
`create-file` (empty file) goes through the client encrypt path instead of server
`writeFile('')`.

---

## 5. Read path

### 5.1 The decrypting Service Worker

One SW (`client/dist/sw.js`, served with `Cache-Control: no-cache`) owns virtual routes:

```
GET /vault/internal/<path>        → decrypted bytes of content/<path>.vlt
GET /vault-dl/<one-time-id>       → streamed client-built zip (§6)
```

For `/vault/...` the SW: `HEAD`s the real ciphertext URL (`/content/...`,
express.static already serves HEAD + ranges) → learns ctSize → computes ptSize → maps
the request's `Range: bytes=X-Y` to blocks ⌊X/1MiB⌋..⌊Y/1MiB⌋ → fetches that ciphertext
range (`512 + i·1048592 …`) with a normal ranged fetch → decrypts per block → responds
`206` with correct plaintext `Content-Range`, `Accept-Ranges: bytes`, and `Content-Type`
derived from the de-suffixed name. A `<video>` element pointed at `/vault/...` seeks
exactly as it does today against express.static; each seek costs ≤1 extra MiB.

Key handoff: page posts MK to the SW after unlock. Browsers kill idle SWs, so the
protocol is pull-based: if the SW lacks MK it `clients.matchAll()` → requests the key
via `MessageChannel` from any unlocked tab → retries; if no tab is unlocked it answers
`409 vault-locked` and the UI shows the unlock prompt. First-ever page load registers
the SW before any vault fetch (one-time `navigator.serviceWorker.ready` gate).

Fallback (no SW: private windows, first paint): fetch whole ciphertext → decrypt →
object URL. Correct for images/text/pdf; large video loses seek-before-buffer only.

### 5.2 Per-surface rewiring

All consumers funnel through one helper (today they hand-build URLs from
`getContentBaseUrl()` in `format.js:86`):

```js
fileUrl(item, path, drive)  // vault file → /vault/...  · plaintext → /content|/drive/...
displayName(item)           // strips .vlt for all UI, icons, extension logic
```

- **PreviewModal** (`PreviewModal.jsx:246-312`): text/image/audio/video/pdf branches just
  use `fileUrl()` — the SW makes them Just Work, including Prism text fetch and the
  `iframe` PDF viewer. The HEIC branch already fetches+converts client-side (heic2any) —
  it fetches from `/vault/` now; that existing code is the proof-of-pattern for the whole
  design.
- **MediaPlayer**: unchanged — it's a chrome around `<video>/<audio src>`; the SW
  provides ranges.
- **CodeEditor**: unchanged (gets text as a prop); only load/save plumbing moves (§4).
- **MOV / CR3 previews** (`apiGetVideoPreview`/`apiGetRawPreview` → server cache): dead
  for vault. Replacements in §5.3.
- **FileItem thumbnails** (`FileItem.jsx:113-123`, currently `/api/thumbnail` → sharp):
  point the `<img>` at the companion through the SW
  (`/vault/internal/<dir>/.photo.jpg.vlt.thumb`) — an ordinary container, so the SW
  decrypts it like any file. Grid of 100 thumbs = 100 × ~20 KB fetches + decrypts —
  milliseconds of CPU, and it removes sharp double-duty from the server.
- **Downloads** (single file): `FileList.jsx` streams `/vault/...` through the SW with
  `Content-Disposition: attachment` — plaintext filename, plaintext bytes, memory-flat.
  Folder downloads: §6.

### 5.3 Upload-time derivative generation (replacing the transcode queue)

The server's ffmpeg/ImageMagick pipeline (`server.js:61-108, 308-379`) cannot exist under
E2EE. Replacements, all at upload time in the client:

| Was (server) | Becomes (client, pre-encryption) | Fidelity |
|---|---|---|
| sharp thumbnails on demand | canvas/`createImageBitmap` → ≤256px JPEG sidecar | same |
| CR3 → JPG (magick/exiftool) | **exifr**-style embedded-preview extraction (CR3 carries a full-size JPEG preview; pure JS box parsing) → preview sidecar | same picture the exiftool fallback used |
| MOV → MP4 transcode | **remux, don't transcode**: most camera/iPhone `.mov` are H.264/HEVC+AAC in a QuickTime container; mp4box.js rewrites the container to fragmented MP4 at ~disk speed, no re-encode. H.264 results play everywhere; HEVC plays in Safari/Edge. True-transcode (ffmpeg.wasm) is possible but slow — not planned. | H.264 ✅ · HEVC partial · exotic codecs: download-only (matching today's unsupported-audio UX) |
| HEIC | already client-side today | same |

The transcoding queue, `triggerPostProcessing`, and `/api/preview/*` are removed for
vault paths (they remain for plaintext external drives if desired).

---

## 6. Folder downloads (client-built zip)

Server-side `archiver` over plaintext (`/api/download` folder branch, `server.js:1110`;
share folder zip, `server.js:1560`) is replaced by: recursive `/api/list` walk → fetch +
decrypt each file (SW or direct) → **fflate** streaming zip (store mode by default — the
bytes were user data, compression is the user's call) → streamed to disk through the
`/vault-dl/` SW route. Memory stays flat at a few MiB regardless of folder size; progress
is real (bytes walked / bytes total). `/api/download` on a vault folder returns 400 with
a hint; on plaintext drives it keeps working.

---

## 7. Server-side operations (the good news)

Because copy/move/rename/duplicate/delete/create-folder in `operation-runner.js` are
pure filesystem ops on opaque paths, **they survive almost untouched**, including crash
resume, the SQLite op store, multi-item ops, cancel, and the longop bar. Same for
`/api/transfer` across drives (a `.vlt` moved to a USB drive just moves ciphertext —
stays encrypted until moved back or explicitly exported; the UI badges it). Two small
adjustments, both flagged by the audit:

1. **Companion rule** (§3.3): rename/move/copy/duplicate/delete of `X` also applies to
   `.X.thumb` if present. ~20 lines in `operation-runner.js`, best-effort.
2. **Conflict-rename names are computed client-side.** `findFreeTransferName`
   (`server.js:462`) and `performDuplicate`'s `(copy)` logic treat `.vlt` as the
   extension, producing `photo.jpg-1.vlt` → display name `photo.jpg-1`, whose *display*
   extension then misparses (wrong icon/category/preview eligibility). Fix: the client
   already gets `existingNames` from `/api/check-conflicts` — it computes the suffix in
   **display space** (`photo-1.jpg`), re-suffixes (`photo-1.jpg.vlt`), and pins it via
   the existing `targetName`/`fixedName` mechanism (`operation_items.targetName`,
   `opts.fixedName`). `/api/transfer` and `/api/copy` gain an optional `targetName`
   field that maps straight onto `fixedName`. Server-side name generation remains for
   plaintext/foreign files.

**Extract/compress die for vault paths** (`performExtract`/`performCompress` read
content). Disposition: the UI hides those actions on vault items in phase 1. A later
optional phase can do zip extract/create client-side (fflate handles both; tar.gz is
also doable) — network-bound but correct. The op-type stays in the store either way.

Conflict checking (`/api/check-conflicts`) keeps working — the client sends stored
(`.vlt`-suffixed) names, and the "keep both / -1 suffix" logic runs on stored names so
collision math matches disk reality.

---

## 8. Sharing under E2EE

Current shares stream plaintext to recipients (`server.js:1530-1574`). New model —
the MEGA/Firefox-Send pattern:

- Creating a share mints a random 256-bit **shareKey**. The link becomes
  `https://host/share/<token>#k=<base64url(shareKey)>` — **the fragment never reaches
  the server** (browsers don't send it), so possession of the link = possession of the
  key, and the server still can't read anything.
- The owner's client builds a **share manifest**: for each file in the shared item,
  `{relPath, wrappedFK(shareKey), ptSize, thumbWrappedFK?}`. Stored server-side keyed by
  token (a `manifest` field on the `share-store.js` record is simplest), encrypted under
  shareKey. Records gain a `hasManifest` flag; tokens/access levels stay as-is.
- **SharePage** parses `#k=`, fetches the manifest, and reuses the exact same SW decrypt
  path (`/vault-share/<token>/<relPath>` virtual route backed by the public
  `/api/public/share/:token/raw` ciphertext endpoint, which needs no changes — it already
  does ranges via `sendFile`). Text/img/video previews on the share page work as today.
- **Share folder downloads move client-side too.** The audit found four plain-`href`
  sites in `SharePage.jsx` (lines 171, 189, 263, 274) pointing at
  `/share/:token/download`, whose folder branch zips the directory raw
  (`server.js:1560`) — for a vault share that would hand recipients a zip of `.vlt`
  ciphertext and `.thumb` companions (the zip walk does *not* apply the dot-filter; only
  `/list` does). For encrypted shares, SharePage builds the zip client-side (§6 flow,
  driven by the manifest); the server endpoint stays for plaintext shares and as an
  explicit "download encrypted backup" option.
- **Staleness:** files added to a shared folder after manifest creation aren't readable
  by recipients until the owner reopens the share dialog (auto-refresh on open). Honest
  and acceptable for a single-owner system — the owner is the only writer.
- **Revocation** deletes the token+manifest: the link dies for future fetches. It cannot
  un-know keys from people who already fetched content (true of every E2EE share system;
  full re-key would mean re-encrypting the files).
- `access: restricted` shares still require a session *and* the fragment key.

---

## 9. Migration of existing data

Client-driven, because only the client can hold keys:

1. **Setup wizard** (first login after upgrade): choose password (may keep current one),
   derive keys, generate + confirm recovery code, write keyring. From now on uploads are
   encrypted; existing files show as "foreign/unencrypted".
2. **Encrypt-in-place crawler** (client): walk `/api/list`; per file: download →
   encrypt → upload as `name.vlt` → verify (HEAD size + decrypt-spot-check first/last
   block) → delete plaintext. Resumable by construction (a file is either `.vlt` or not);
   progress via the existing longop UI. Throughput is LAN/disk-bound; a multi-TB library
   takes hours-days but survives interruption.
3. **Purge plaintext derivatives:** `content/cache/*` (thumbnails, transcodes),
   `converted/` (holds at least one plaintext JPG today), stale `uploads/` scratch, and
   **`locks.json`** (audit: dead legacy data, zero code references, contains folder
   names + bcrypt hashes — delete it). These contain decrypted copies/derived secrets
   and their deletion is part of the security claim.
4. Server logs (`morgan`/winston access lines with file names) keep leaking *names* —
   consistent with plaintext-names phase 1; revisit if names get encrypted.
5. **Prune dead deps** while in here: `jszip`, `werift`, `drivelist`, `pptx-preview`,
   `pptxjs` are declared but never required anywhere (audit-verified) — and `helmet` is
   declared but never *used*; start using it (§1).

---

## 10. Performance budget

| Cost | Number | Verdict |
|---|---|---|
| AES-GCM in WebCrypto | ~1–3 GB/s (hardware) | never the bottleneck vs LAN/disk |
| Size overhead | 512 B + 16 B/MiB ≈ 0.0018% | invisible |
| Storage overhead | thumbnail sidecars ~10–30 KB per image | the only real cost |
| Login KDF | Argon2id 64 MiB/t=3 ≈ 0.3–0.8 s | once per session |
| Video seek | ≤1 MiB extra ciphertext fetch + ~1 ms decrypt | imperceptible on LAN |
| Upload CPU | a few % on top of hashing/IO | 3 concurrent files unchanged |
| SW hop | one in-process fetch indirection | ~0 |

---

## 11. What survives, what changes, what dies

| Feature | Fate | Mechanism |
|---|---|---|
| Upload (incl. folders, resume, multi-tab visibility) | ✅ survives | client encrypt stage; server untouched |
| Download single file | ✅ survives | SW decrypt stream |
| Copy/move/rename/duplicate/delete/create-folder + crash-resume | ✅ untouched | opaque blobs |
| Cross-drive transfer | ✅ untouched | ciphertext travels (badged) |
| List/sort/breadcrumbs/type filter | ✅ survives | `displayName()` strip + invertible sizes |
| Sizes, Info modal, storage widget | ✅ survives | ciphertext↔plaintext size math |
| Image/text/PDF/audio/MP4 preview | ✅ survives | SW ranges |
| Video scrubbing | ✅ survives | block-aligned range decryption |
| Text editing in place | ✅ survives | re-encrypt-on-save (new FK) |
| Thumbnails | ✅ survives (moves) | upload-time client generation + sidecars |
| HEIC preview | ✅ already client-side | unchanged pattern |
| CR3 preview | ✅ survives (moves) | embedded-JPEG extraction at upload |
| MOV playback | ⚠️ degrades | client remux (H.264 ✅, HEVC partial, else download-only) |
| Name search | ✅ survives | server WS name-walk unchanged (names plaintext) |
| **Content search** | ❌ dies (phase-4 option: client-built encrypted index) | server can't read text |
| Folder download as zip | ✅ survives (moves) | client fflate + SW stream |
| Extract/compress archives | ❌ dies for vault (phase-4 option: client-side zip) | server can't read archives |
| Share links (file + folder, public/restricted) | ✅ survives (rebuilt) | key-in-fragment + manifest |
| Bandwidth/network/CPU/drive widgets | ✅ untouched | never touched contents |
| Ops progress bar / durable operations | ✅ untouched | byte counts shown via size math |

---

## 12. Residual metadata leaks (phase 1, deliberate — enumerated)

- Filenames + extensions, directory tree shape, file count (on-disk names).
- Plaintext sizes (exactly recoverable from ciphertext sizes — by design, for UX),
  mtimes, access patterns.
- Thumbnail companions reveal "is an image/video" and rough visual complexity via size.
- `operations.db`: `relPath`/`name` per operation item. `shares.json`: name + path per
  share. Winston/morgan logs: full paths and names (`server.js:642, 1009, 1084`).
- Bandwidth/network stats: pure byte counters — clean.

Encrypting names (§13) would remove the first bullet and force scrubbing the
db/logs/shares entries; the rest are inherent to any file-granular scheme short of
padded, oblivious storage.

---

## 13. Open decisions

1. **Filename encryption** (phase 4, default **no**): AES-SIV names Cryptomator-style
   would break name search, server-side conflict logic, log readability, and Windows
   path-length headroom; for a personal server the tree-shape leak is usually
   acceptable. Decide after living with phase 1.
2. **MOV policy:** remux-at-upload (recommended) vs keep-original-only.
3. **Remember-device unlock:** convenience vs cold-boot protection; default off.
4. **Default for uploads to external drives:** encrypted vs plaintext toggle default
   (recommended: plaintext, remembered per drive — removable media is usually for
   interchange; §2).
5. **Foreign-file policy:** auto-encrypt on discovery vs manual button (recommended:
   manual, with a badge — auto-encrypt surprises whatever wrote the file).

## 14. Phasing & effort (solo, focused)

| Phase | Contents | Estimate |
|---|---|---|
| P0 | TLS (Caddy `tls internal` / Tailscale cert), session secret → env, actually use helmet, secure+SameSite cookies, self-host the Google Fonts in `client/index.html` (SW + CSP hygiene), delete `locks.json`, prune dead deps (§9 step 5) | 1–2 days |
| P1 core | keyring + setup/unlock UI + login rework; crypto module (shared page/SW); upload encrypt pipeline; SW read path; display/stored-name normalization; editor save; vault guards + companion rule server-side; migration crawler; cache purge | 3–5 weeks |
| P2 parity | client thumbnails + CR3 extraction + MOV remux; client folder zip; size/progress inversion polish; conflicts UX | 2–3 weeks |
| P3 shares | shareKey manifests, SharePage decrypt (incl. client-side folder zip), revocation UX | 1–2 weeks |
| P4 optional | content-search index, client archive ops, filename encryption, remember-device unlock | open-ended |

Realistic total to full parity: **~2–3 months part-time**. The crypto core is small
(~1–2 KLOC including the SW); the calendar goes to the long tail of §11.

---

## 15. Implementation specification

Everything below is decided, not optional — an implementer should not need to make a
design choice while coding. Where a value is arbitrary it is pinned anyway.

### 15.1 New modules & touched files

```
client/src/crypto/const.js      constants below; the single source of truth
client/src/crypto/kdf.js        deriveRoot (argon2id via hash-wasm), deriveAuthKey, deriveKek (HKDF)
client/src/crypto/keyring.js    createKeyring / unlock / changePassword / unlockWithRecovery
client/src/crypto/container.js  header build/parse, wrapFK/unwrapFK, encryptBlock/decryptBlock, size math
client/src/crypto/encrypt-stream.js  File → ciphertext ReadableStream (+ discard-until-offset resume)
client/src/crypto/idb.js        pendingUploads store (schema §15.6)
client/src/crypto/names.js      toStored/toDisplay/isEncrypted/companionName
client/src/context/VaultContext.jsx  unlock state, MK handle, SW key-supply listener
client/src/components/modals/VaultSetupModal.jsx   first-run wizard + recovery code
client/sw/sw.js                 service worker source (§15.7), built standalone
client/sw/build.mjs             esbuild bundle → client/dist/sw.js (bundles fflate; no other deps)

touched: useUpload.js (encrypt stage) · fetch.js (names at API boundary) · format.js
(display-ext helpers) · FileItem/FileList/PreviewModal/SharePage/LoginPage/SettingsModal
· AppContext (SET_FILE_DATA normalization) · server.js (§15.8) · operation-runner.js
(companion rule) · share-store.js (manifest field)
```

### 15.2 Constants and size math (canonical)

```js
H = 512                     // header bytes
BS = 1_048_576              // plaintext block
TAG = 16                    // GCM tag
CBS = BS + TAG              // 1_048_592 ciphertext block
CHUNK = 10 * 1024 * 1024    // transport chunk — MUST stay equal to server.js:962
MAGIC = 'VLT1'; SUFFIX = '.vlt'
companionName(stored) = '.' + stored + '.thumb'      // guard regex: /^\..*\.thumb$/
INFO_AUTH = 'velocity/auth/v1'; INFO_KEK = 'velocity/kek/v1'; AAD_FK = 'VLT1-FK'
ARGON = { mMiB: 64, t: 3, p: 1, outLen: 32 }         // hash-wasm argon2id
BCRYPT_COST = 12

nBlocks(pt) = pt === 0 ? 1 : ceil(pt / BS)
ctSize(pt)  = H + pt + TAG * nBlocks(pt)
ptSize(ct)  = { body = ct - H; n = ceil(body / CBS); return body - TAG * n }
ctRange(i)  = [H + i*CBS, min(H + (i+1)*CBS, ctTotal) - 1]   // inclusive byte range
blockOfPt(x) = floor(x / BS)
```

Endianness: `plaintextSize` u64 **LE**, `blockSize` u32 **LE** (header); block counter
u32 **BE** in both nonce and AAD (network order for the wire-ish parts, LE for the
struct-ish parts — arbitrary but pinned). Limits: 4-byte counter × 1 MiB = 4 PiB/file.
Property test: `ptSize(ctSize(x)) === x` for x ∈ {0, 1, BS−1, BS, BS+1, 10·BS,
10·BS+1, 3.5 GiB}.

### 15.3 Keyring, auth files, and flows

Server stores two small JSON files (atomic write: tmp + rename), no schema migration:

```jsonc
// auth.json  — replaces the hardcoded PASSWORD_HASH (server.js:33)
{ "user": "mdoan", "authHash": "$2b$12$..." }            // bcrypt(authKeyB64)

// keyring.json
{ "v": 1,
  "saltRoot": "b64(16B)", "saltRec": "b64(16B)",
  "argon": { "mMiB": 64, "t": 3, "p": 1 },
  "wrappedMK":    { "n": "b64(12B)", "ct": "b64(32+16B)" },   // AES-GCM(KEK, MK)
  "wrappedMKRec": { "n": "b64(12B)", "ct": "b64(32+16B)" },   // AES-GCM(recKey, MK)
  "createdAt": "ISO" }
```

Routes (all in server.js, ~80 lines total):

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/keyring/public` | none | `{setup: !exists, saltRoot, argon}` — salts aren't secret; needed pre-login |
| `POST /api/keyring/setup` | none, one-time | body `{legacyPassword, authKey, keyring}`; verify legacyPassword against old hash; write both files; `409` if keyring exists |
| `GET /api/keyring` | session | full keyring.json |
| `PUT /api/keyring` | session + body.currentAuthKey bcrypt-verifies | replace keyring (+ optional new authHash) — used by password change & recovery-reset |

**Login:** `POST /login` keeps its exact shape; the `password` field now carries
`base64url(authKey)`. Server logic unchanged (bcrypt compare), reads auth.json, falls
back to the legacy constant until setup has run. LoginPage flow: fetch
`/api/keyring/public` → if `setup:false` run VaultSetupModal → else derive rootKey
(argon2id, ~0.5 s spinner) → authKey → POST → fetch keyring → unwrap MK with KEK →
`VaultContext.unlock(mk)` → post MK to SW.

**Password change** (SettingsModal, new "Vault" section — audit confirmed the modal is
theme-only today, greenfield): derive old (verify by unwrapping MK), derive new, re-wrap
MK, `PUT /api/keyring` with new authHash. **Recovery:** input code → derive recKey →
unwrap via `wrappedMKRec` → same PUT path with a fresh password. Both flows never move
file keys — MK never changes for the life of the vault.

### 15.4 Container encode/decode (normative pseudocode)

```
encryptFile(file, mk):
  fk = random(32); fileId = random(16); prefix = random(8)
  wrappedFK = gcmEncrypt(mk, fk, nonce=random(12), aad=utf8(AAD_FK)||fileId)
  header = pack512(MAGIC,1,1,0, BS, u64le(file.size), fileId, prefix,
                   wrappedFK.n || wrappedFK.ct)          // rest zero
  hh = sha256(header)
  for i in 0..nBlocks(file.size)-1:
    pt = file.slice(i*BS, min((i+1)*BS, file.size))      // empty slice when size==0
    nonce = prefix || u32be(i)
    yield gcmEncrypt(fk, pt, nonce, aad = hh || u32be(i))

decryptBlock(fk, hh, i, ctBlock): inverse; GCM failure ⇒ VaultIntegrityError(i)
openHeader(mk, bytes512):
  assert magic==MAGIC else ForeignFileError    // a mis-suffixed plaintext file
  fk = gcmDecrypt(mk, wrappedFK, aad=AAD_FK||fileId)  // failure ⇒ WrongKeyError
  return { fk, ptSize, hh: sha256(bytes512) }
```

MK is transferred between page and SW as raw bytes (structured clone), imported as a
non-extractable `CryptoKey` in each context, source buffer zeroed after import
(best-effort hygiene, not a guarantee).

### 15.5 Display/stored name normalization (one seam, two known bypasses)

All list/search ingestion (`SET_FILE_DATA`, WS `search_result`) normalizes items once:

```js
{ name: display, storedName, encrypted: isEncrypted(storedName),
  size: encrypted ? ptSize(statSize) : statSize, ... }
```

Rules: **render/`format.js` logic uses `name`; every API call uses `storedName`**
(rename/delete/transfer/download/conflicts/share). `fetch.js` helpers take the item, not
a string, to make the wrong call unrepresentable. The audit found exactly two paths that
bypass ingestion — both must carry the pair explicitly:
1. PreviewModal's gallery scrape of DOM datasets (`PreviewModal.jsx:45`): FileItem emits
   `data-name` (display) **and** `data-stored-name`; eligibility uses display, fetches
   use stored.
2. `/api/check-conflicts` round trip: send stored top-level names; `existingNames` comes
   back stored; `conflicts.js` computes `-1` suffixes in **display space**
   (`report.pdf` → `report-1.pdf`), re-suffixes, then collision-checks against the
   stored `existingNames` set (order matters — checking display candidates against
   stored names falsely passes).

Rename UI: user edits the display name; client re-suffixes before `/api/rename`.
Sort-by-size uses converted sizes (monotonic anyway); sort-by-type uses display ext.

### 15.6 Upload pipeline

IndexedDB `velocity-vault`, store `pendingUploads`, key `` `${opId}:${relPathStored}` ``:

```jsonc
{ "fileId": "b64", "header": "b64(512B exact)", "wrappedFK": {"n","ct"},  // under MK
  "fingerprint": { "size": 123, "lastModified": 456 }, "ctSize": 999, "createdAt": "ISO" }
```

Per file in `UploadManager.uploadFile`:
1. `prep`: generate keys, build header, write IDB record. All wire fields use stored
   names: `x-file-name`/`x-relative-path`/op-item `name`/`relPath` get `SUFFIX`;
   `x-total-file-size` and op-item `size` = `ctSize`.
2. Stream: pull 1 MiB slices → `encryptBlock` (pipeline 4 in flight) → rolling buffer →
   emit exact `CHUNK`-sized transport chunks through the existing `sendChunk` retry
   loop. Progress display converts uploaded ciphertext bytes back through `ptSize()`
   (audit finding: the resume fast-forward at `useUpload.js:87-95` must apply the same
   inversion or the bar over/undershoots).
3. Resume (op known): `/upload-offset` → if IDB record missing or fingerprint mismatch ⇒
   fresh FK + restart at chunk 0 (server `'w'` truncates). Else re-create the stream
   with persisted header+FK, **discard until offset**, verify server bytes 0–511 ==
   persisted header, continue.
4. After the final chunk of an image/video/CR3: build thumbnail (image:
   `createImageBitmap`→canvas→JPEG q0.7 ≤256px; video: seek 25%, capture frame —
   only for browser-playable containers; CR3: exifr embedded preview) → encrypt as its
   own container → upload to `companionName(stored)` as a 1-chunk upload outside the op
   record (failure = non-fatal, lazy backfill covers it).
5. Editor save = same path with 1 file, fresh FK, `conflict: replace` semantics.
   Zero-byte create-file = header + 1 empty block (528 B).

### 15.7 Service Worker (`client/sw/sw.js`)

Built standalone by esbuild (bundles **fflate** only; WebCrypto for the rest), emitted to
`client/dist/sw.js` so express.static serves it at origin root → scope `/`. Serve with
`Cache-Control: no-cache` (setHeaders hook). Registered in `main.jsx` after login page
mount; `skipWaiting` + `clientsClaim`. **Passthrough by default**: `fetch` handler calls
`respondWith` only for the three virtual prefixes; everything else falls through
untouched (login, API, static, HMR in dev — localhost is a secure context, so dev works
with the existing Vite proxy unchanged; virtual routes never hit the network).

State (all in-memory, rebuilt on demand): `mk: CryptoKey|null`; `fkCache: LRU(200)
url+etag → {fk, ptSize, hh}`; `shareKeys: Map(token → CryptoKey)`; `zipJobs: Map(id →
entries)`.

Messages: `{t:'unlock', mk}` `{t:'lock'}` page→SW · `{t:'needKey'}` SW→clients (page
replies with unlock) · `{t:'share.key', token, key}` · `{t:'zip.begin', id, name,
entries:[{srcUrl, zipPath, ptSize}]}`.

`GET|HEAD /vault/<driveId>/<storedPath>[?dl=1]`:
```
1  mk? else broadcast needKey, await ≤2s ⇒ else 409 JSON {error:'vault_locked'}
2  realUrl = driveId==='internal' ? '/content/'+p : '/drive/'+driveId+'/'+p
3  meta: HEAD realUrl → {ctSize, etag}; fkCache hit on url+etag? else GET bytes=0-511,
   openHeader(mk) → cache {fk, ptSize, hh}   (ForeignFileError ⇒ 302 to realUrl)
4  Range parse → (start, end) in plaintext space; none ⇒ 200 full, else 206 with
   Content-Range start-end/ptSize; bytes=X- means end = ptSize-1; unsatisfiable ⇒ 416
5  body = ReadableStream pull loop: for i = blockOfPt(start)..blockOfPt(end):
     fetch realUrl Range: ctRange(i) → decryptBlock → enqueue slice clipped to [start,end]
   (sequential, one block read-ahead; cancel() aborts the underlying fetch)
6  headers: Content-Type = mime(displayName) | octet-stream; Content-Length exact;
   Accept-Ranges: bytes; Cache-Control: no-store; dl=1 ⇒ Content-Disposition:
   attachment; filename*=displayName. HEAD ⇒ headers only.
7  decryptBlock failure after streaming began ⇒ error the stream (consumer sees abort);
   before ⇒ 502 JSON {error:'vault_corrupt', block:i}
```
ETag in the cache key is the invalidation story: an editor save rewrites the file,
express.static mints a new ETag, next fetch re-reads the new header. Never reuse an FK
across ETags.

`/vault-share/<token>/<relPath>`: same, with `shareKeys.get(token)` unwrapping the
manifest entry instead of MK, backed by `/api/public/share/<token>/raw?subpath=`.

`/vault-dl/<id>` (client zip): page posts `zip.begin` then navigates an `<a>` to the
URL; SW responds `200` attachment whose body streams `fflate.Zip` (store mode, Zip64 on)
fed by sequential fetch-and-decrypt of each entry. Flat memory; cancel propagates.

Fallback when SW is unavailable (private windows, first paint): `fetchAndDecrypt(url) →
Blob` for text/images/PDF/audio; video plays without seek-ahead; folder zip falls back
to in-memory assembly — the audit confirmed today's folder download *already* buffers
whole zips in memory (`FileList.jsx:196`), so this is not a regression.

### 15.8 Server diff (complete route-by-route)

| Site | Change |
|---|---|
| `server.js:32-33` | `USERNAME`/`PASSWORD_HASH` → read auth.json (legacy const = pre-setup fallback) |
| `POST /login` (611) | unchanged logic; compares authKey; add small delay on failure as today |
| new `/api/keyring*` | §15.3 table |
| `express.static` mounts (548-550) | `setHeaders`: `sw.js` no-cache; rest unchanged (already serves Range/HEAD/ETag for ciphertext) |
| `/api/thumbnail` (890) | `400` if target `isEncrypted` (foreign files keep sharp) |
| `/api/preview/raw`, `/api/preview/video` (933, 947) | `400` for `.vlt` targets (cache never populates anyway) |
| `triggerPostProcessing` (295) | no change needed — `.vlt` never matches `.mov`/`.cr3` (audit: "pleasant accident"); add a regression test so nobody "fixes" it |
| `/api/save-file` (1298) | `400` if `name` ends `.vlt` |
| `/api/extract`, `/api/compress` (1203, 1217) + op enqueue guard (1346-1356) | `400` for `.vlt` items; UI hides the actions |
| `/api/download` (1074) | file: serves ciphertext as-is = "export encrypted" (normal downloads go through `/vault?dl=1`); folder: keep as encrypted-backup export; UI uses client zip for vault folders |
| WS search (1658) | name-match against de-suffixed name; return stored name in results (fixes the query-"vlt"-matches-everything wart; content branch self-skips since `.vlt` ∉ SEARCHABLE_EXTENSIONS) |
| `operation-runner.js` transfer/rename/duplicate/delete | companion rule (§3.3); `/api/transfer` + `/api/copy` accept optional `targetName` → `fixedName` (§7) |
| `getDirectoryStats` (1440) + `size-worker.js` | skip `/^\..*\.thumb$/` |
| `share-store.js` | record += `{hasManifest, manifest}` (manifest is ciphertext-under-shareKey, opaque to server) |
| shares routes (1495-1576) | `GET /:token` also returns `hasManifest`; `PUT /:token/manifest` (owner, authed) stores it; `/raw` + folder `/download` byte paths unchanged |
| delete | `locks.json`; `converted/`; prune `jszip`,`werift`,`drivelist`,`pptx-preview`,`pptxjs`; wire up `helmet`; session secret from env |

### 15.9 Share manifest

```jsonc
// stored on the share record, encrypted: gcm(shareKey, utf8(json), aad=token)
{ "v": 1, "root": "folder|file",
  "files": [ { "p": "sub/dir/photo.jpg.vlt",        // relPath, stored names
               "fk": {"n","ct"},                     // FK wrapped under shareKey
               "pt": 1234567,
               "tfk": {"n","ct"} } ] }               // companion FK, optional
```

Owner flow (ShareModal open/create): walk the item via `/api/list`, read each header
(ranged 512 B GETs), unwrap FKs with MK, re-wrap under shareKey, PUT manifest; link =
`/share/<token>#k=<base64url(shareKey)>`. Reopening the modal rebuilds the manifest
(covers staleness); a share of N files costs N tiny reads — acceptable to ~thousands.
Recipient flow: parse fragment → post `share.key` to SW → fetch+decrypt manifest →
previews via `/vault-share/...`, folder download via `/vault-dl/`. Restricted shares:
session check stays server-side; the fragment key is still required to read bytes.

### 15.10 Migration crawler (client)

```
for each entry in DFS(/api/list, drive='internal'):
  skip if isEncrypted(name) or companion or dot-entry
  download plaintext (existing /content path) → encryptFile → upload as name+'.vlt'
    (normal chunk pipeline, own op record per batch of ~100)
  verify: HEAD size === ctSize(ptSize) && decrypt-spot-check blocks {0, last}
  delete plaintext original (existing /api/delete)
resumable by construction: a file is either .vlt or it isn't; re-run continues
then: purge content/cache/*, converted/, locks.json; generate thumbnails lazily on browse
```

Fixture cases the test suite must cover: reserved Windows names (`con.txt` arrives
sanitized already), unicode names, 200+ char names (suffix pushes toward MAX_PATH —
rely on Windows long-path support; document the registry key), 0-byte files, a file
modified mid-migration (fingerprint check ⇒ re-encrypt).

### 15.11 Failure modes (uniform behaviors, no ad-hoc handling)

| Condition | Detection | Behavior |
|---|---|---|
| wrong password | bcrypt 401 at /login | normal login error |
| right password, corrupt keyring | login ok, MK unwrap fails | blocking error + recovery-code path; never "empty vault" |
| vault locked in SW | no MK, needKey timeout | 409 → VaultContext shows unlock modal, retries after unlock |
| corrupted/tampered block | GCM fail | pre-stream: 502 + toast with block index; mid-stream: abort (media element fires error → existing onError UIs) |
| `.vlt` without magic | openHeader | treat as foreign file, badge "misnamed", serve raw |
| companion missing/corrupt | fetch 404 / GCM fail | generic icon; enqueue lazy backfill |
| SW unavailable | registration fails | blob fallback (§15.7); banner for large video |
| resume without IDB record / fingerprint mismatch | IDB lookup | silent fresh-FK restart from chunk 0 |
| share link without `#k=` | SharePage parse | explainer page ("this link is missing its key part") |
| manifest stale (file added after share) | 404 on manifest lookup of a listed file | per-file "ask owner to refresh share" row, rest works |

### 15.12 Dependencies (all bundled, no CDN — matches current CSP posture)

| Dep | For | Size | Phase |
|---|---|---|---|
| `hash-wasm` | Argon2id (WebCrypto has none; PBKDF2-600k is the no-wasm fallback, pinned as config so vectors stay valid) | ~60 KB | P1 |
| `fflate` | client zip (streams, Zip64) | ~30 KB | P2/P3 |
| `exifr` | CR3/HEIC embedded-preview extraction | ~40 KB | P2 |
| `mp4box.js` | MOV→fMP4 remux (no re-encode) | ~150 KB | P2, optional |
| `heic2any` | already present | — | — |

### 15.13 Test plan (the security claims are only as real as these)

**Unit (vitest, page + node webcrypto):** size-math property tests (§15.2 list); header
round-trip; golden vectors generated once via Node webcrypto and pinned in-repo;
tamper matrix — flip any header byte ⇒ every block fails; flip a block byte ⇒ that block
fails; swap blocks i/j ⇒ both fail; truncate ⇒ size check fails; append garbage ⇒
ignored by size and flagged; nonce-uniqueness assertion in encrypt-stream (counter never
reused per FK, enforced + tested).

**Integration (Playwright against `https://localhost` full stack):** upload→download
byte-identity (hash) for 0 B / 1 B / 9.9 MB / 3.5 GB; kill server (SIGKILL) mid-upload →
restart → resume → hash identity (exercises the persisted-header rule); video seek
(assert ≥2 ranged 206s through SW + `currentTime` lands); editor save round-trip + ETag
invalidation (old FK must not decrypt new bytes); rename/copy/duplicate via UI keep
sane display names and carry companions; share e2e incl. folder zip and fragment-less
link; migration on a fixture tree incl. §15.10 cases, then **post-migration disk scan:
every non-dot file under `content/` starts with `VLT1` and no plaintext survives in
`cache/`/`converted/`** — this scan *is* the acceptance test for the whole project.

---

## 16. Appendix: audit outcomes (full-repo review)

Independent full-codebase audit (all UI surfaces, stores, hooks, deps, deployment).
Verdicts: **no design pin invalidated**; pins 1, 6, 8 amended as now reflected in §2,
§3.3, §8. Finding → resolution map:

| # | Finding (severity) | Resolved in |
|---|---|---|
| 1 | No secure context on LAN — plain-HTTP deploy confirmed in-repo (`ShareModal.jsx:5`), `crypto.subtle` undefined on `http://LAN-IP` (BLOCKER) | §1 TLS prerequisite, §14 P0 |
| 2 | `findFreeTransferName`/`(copy)` naming treats `.vlt` as extension → corrupt display names (HIGH) | §7.2, §15.5, §15.8 |
| 3 | Sidecar orphaning by server-side ops; `/api/info`+size-worker count drift (HIGH) | §3.3 companion rule, §15.8 |
| 4 | Share folder downloads server-zip raw ciphertext incl. companions; 4 href sites (HIGH) | §8, §15.9 |
| 5 | Resume can't rebuild header (random wrap nonce) ⇒ AAD mismatch on every post-resume block (MED) | §4 resume rules, §15.6 |
| 6 | PreviewModal gallery scrapes DOM names (MED) | §15.5 bypass 1 |
| 7 | Drive-scoped vault incoherent under cross-drive transfer (MED) | §2 reframed per-file |
| 8 | Selection/ops keyed by raw `item.name` across many sites (MED) | §15.5 normalization seam |
| 9 | check-conflicts display/stored space mixing (LOW) | §15.5 bypass 2 |
| 10 | Content-search loss is silent; "vlt" query matches everything (LOW) | §15.8 WS search row |
| 11 | Upload progress plaintext/ciphertext double bookkeeping (LOW) | §15.6 step 2 |
| 12 | At-rest metadata: logs, operations.db, shares.json, dead `locks.json` (incl. bcrypt hashes), plaintext JPG in `converted/` (LOW) | §9, §12 |
| 13 | Dead deps: jszip, werift, drivelist, pptx-preview, pptxjs; helmet unused (LOW) | §9 step 5, §14 P0 |
| 14 | Confirmations: MediaPlayer is pure `<video src>`; express.static already Range/HEAD-capable; today's folder zip buffers in memory (so blob fallback ≠ regression); heic2any = existing client-decode precedent; LongOpStatusBar % math survives | §5, §15.7 |

Deployment notes from the audit: Caddy `tls internal` or Tailscale cert (best), mkcert
third; `wss:` protocol switch already handled (`useWebSocket.js:13`); `sw.js` emitted at the dist root gives `/` scope (built
standalone — §15.7); Google Fonts in `client/index.html` should be self-hosted (P0).
