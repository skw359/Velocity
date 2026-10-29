// Free and total space of the volume holding a path, from the operating system's statfs
// (Node's fs.statfs). Same shape as the diskusage addon it replaces, which had no prebuilt
// binaries and had to be compiled on every install.

const fs = require('fs');

// { available, free, total } in bytes. available is what this process may still write
// (it excludes space reserved for root, and honours per-user quotas on Windows).
async function check(target) {
  const s = await fs.promises.statfs(target);
  return {
    available: s.bavail * s.bsize,
    free: s.bfree * s.bsize,
    total: s.blocks * s.bsize,
  };
}

module.exports = { check };
