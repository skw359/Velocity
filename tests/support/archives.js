// Minimal ZIP and TAR writers for tests. Real archivers refuse to store names like
// "../x" or links pointing outside, which is exactly what the extraction tests need.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data?: Buffer|string, mode?: number (st_mode incl. type bits),
//   deflate?: boolean, encrypted?: boolean, dosDir?: boolean }]
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    // ZipCrypto prefixes each encrypted entry's data with a 12-byte header.
    const stored = Buffer.concat([e.encrypted ? Buffer.alloc(12, 0xa5) : Buffer.alloc(0), e.deflate ? zlib.deflateRawSync(data) : data]);
    const method = e.deflate ? 8 : 0;
    const flags = 0x0800 | (e.encrypted ? 1 : 0);
    const crc = crc32(data);
    const mode = e.mode == null ? 0o100644 : e.mode;
    const external = ((mode & 0xffff) << 16 | (e.dosDir ? 0x10 : 0)) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const TAR_TYPES = { file: '0', hardlink: '1', symlink: '2', chardev: '3', dir: '5', fifo: '6', pax: 'x' };

function tarHeader({ name, size = 0, type = 'file', mode, linkname = '' }) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(mode == null ? (type === 'dir' ? 0o755 : 0o644) : mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(1700000000, 12), 136, 12);
  put('        ', 148, 8);
  put(TAR_TYPES[type] || '0', 156, 1);
  put(linkname, 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function padBlock(buf) {
  const rem = buf.length % 512;
  return rem ? Buffer.concat([buf, Buffer.alloc(512 - rem)]) : buf;
}

// entries: [{ name, data?, type?: 'file'|'dir'|'symlink'|'hardlink'|'chardev'|'fifo',
//   mode?, linkname?, paxPath?: string (a PAX header overriding the name) }]
function buildTar(entries, { gzip = false } = {}) {
  const parts = [];
  for (const e of entries) {
    if (e.paxPath != null) {
      const body = (() => {
        const record = (len) => `${len} path=${e.paxPath}\n`;
        let len = record(0).length;
        while (record(len).length !== len) len = record(len).length;
        return Buffer.from(record(len), 'utf8');
      })();
      parts.push(tarHeader({ name: 'PaxHeader', size: body.length, type: 'pax' }), padBlock(body));
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '', 'utf8');
    const isFile = !e.type || e.type === 'file';
    parts.push(tarHeader({ name: e.name, size: isFile ? data.length : 0, type: e.type || 'file', mode: e.mode, linkname: e.linkname }));
    if (isFile && data.length) parts.push(padBlock(data));
  }
  parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gzip ? zlib.gzipSync(tar) : tar;
}

module.exports = { buildZip, buildTar, crc32 };
