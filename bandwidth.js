const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

const STATS_FILE = config.BANDWIDTH_FILE;

// uploaded = bytes received by the server; downloaded = bytes sent by it.
const stats = { uploaded: 0, downloaded: 0 };
let dirty = false;

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      stats.uploaded = Number(data.uploaded) || 0;
      stats.downloaded = Number(data.downloaded) || 0;
      logger.info(`[Bandwidth] Loaded lifetime totals: ${stats.uploaded} bytes up, ${stats.downloaded} bytes down`);
    }
  } catch (err) {
    logger.error(`[Bandwidth] Failed to load stats, starting from zero: ${err.message}`);
  }
}

function persist() {
  if (!dirty) return;
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
    dirty = false;
  } catch (err) {
    logger.error(`[Bandwidth] Failed to persist stats: ${err.message}`);
  }
}

function addUploaded(bytes) {
  if (bytes > 0) {
    stats.uploaded += bytes;
    dirty = true;
  }
}

function addDownloaded(bytes) {
  if (bytes > 0) {
    stats.downloaded += bytes;
    dirty = true;
  }
}

function getStats() {
  return { uploaded: stats.uploaded, downloaded: stats.downloaded };
}

const saveTimer = setInterval(persist, 10000);
if (saveTimer.unref) saveTimer.unref();

load();

module.exports = { addUploaded, addDownloaded, getStats, persist };
