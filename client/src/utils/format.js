export function formatBytes(bytes, decimals = 1) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear().toString().slice(-2);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${month}/${day}/${year} at ${hours}:${minutes}`;
}

export function formatDateOnly(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

export function formatDateTime(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year} at ${hours}:${minutes}`;
}

export function formatSpeed(bytesPerSecond, decimals = 1) {
  if (!+bytesPerSecond) return '0 B/s';
  const bitsPerSecond = bytesPerSecond * 8;
  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  if (bitsPerSecond < 1) return `${bitsPerSecond.toFixed(dm)} bps`;
  const i = Math.floor(Math.log(bitsPerSecond) / Math.log(k));
  return `${parseFloat((bitsPerSecond / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export const languageMap = {
  js: 'javascript', py: 'python', html: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', swift: 'swift', json: 'json', sh: 'bash', md: 'markdown',
  yaml: 'yaml', yml: 'yaml', ini: 'ini', cfg: 'ini', txt: 'plaintext'
};

export const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
export const heicExtensions = ['heic', 'heif'];
export const videoExtensions = ['mp4'];
export const movExtensions = ['mov'];
export const pdfExtensions = ['pdf'];
export const archiveExtensions = ['zip', 'gz', 'tar.gz', 'rar', '7z', 'bz2', 'xz'];
export const rawImageExtensions = ['cr3'];
// ALAC ships inside .m4a containers, so it is covered by the 'm4a' entry.
export const audioExtensions = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'caf', 'opus', 'aiff', 'aif', 'wma', 'mid', 'midi'];

export function getFileExtension(name) {
  if (name.endsWith('.tar.gz')) return 'tar.gz';
  return name.split('.').pop().toLowerCase();
}

// Archives get Extract instead of Compress in the actions menus.
export function isArchiveItem(name, type) {
  return type === 'file' && archiveExtensions.includes(getFileExtension(name));
}

// Coarse type for the "view by type" filter; must match FileItem's icon logic.
export function getFileCategory(item) {
  if (item.type === 'folder') return 'folder';
  const ext = getFileExtension(item.name);
  if (imageExtensions.includes(ext) || heicExtensions.includes(ext) || rawImageExtensions.includes(ext)) return 'image';
  if (videoExtensions.includes(ext) || movExtensions.includes(ext)) return 'video';
  if (audioExtensions.includes(ext)) return 'audio';
  if (pdfExtensions.includes(ext)) return 'pdf';
  if (archiveExtensions.includes(ext)) return 'archive';
  return 'file';
}

export function getContentBaseUrl(driveId) {
  if (driveId === 'internal') return '/content';
  return `/drive/${driveId}`;
}
