const fs = require('fs').promises;
const config = require('./config');
const logger = require('./logger');

const STATS_FILE = config.NETWORK_STATS_FILE;
const SAVE_INTERVAL_MS = 5000;

let totalSent = 0;
let totalReceived = 0;

let currentIntervalSent = 0;
let currentIntervalReceived = 0;
let lastIntervalSentSpeed = 0;
let lastIntervalReceivedSpeed = 0;

let saveIntervalId = null;

// unref: a statistics tick must never be what keeps the process alive.
setInterval(() => {
    lastIntervalSentSpeed = currentIntervalSent;
    lastIntervalReceivedSpeed = currentIntervalReceived;

    currentIntervalSent = 0;
    currentIntervalReceived = 0;
}, 1000).unref();

function addSent(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return;
    totalSent += bytes;
    currentIntervalSent += bytes;
}

function addReceived(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return;
    totalReceived += bytes;
    currentIntervalReceived += bytes;
}

function getStats() {
    return {
        totalSent,
        totalReceived,
        sendSpeed: lastIntervalSentSpeed,
        receiveSpeed: lastIntervalReceivedSpeed,
    };
}

async function loadStats() {
    try {
        const data = await fs.readFile(STATS_FILE, 'utf8');
        const [loadedSent, loadedReceived] = data.split(',').map(Number);

        if (!isNaN(loadedSent) && !isNaN(loadedReceived)) {
            totalSent = loadedSent;
            totalReceived = loadedReceived;
            logger.info(`[Network Stats] Loaded totals: Sent=${totalSent}B, Received=${totalReceived}B`);
        } else {
            logger.warn('[Network Stats] Corrupt or empty stats file. Initializing totals to 0.');
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Network Stats] No stats file found. Initializing totals to 0.');
        } else {
            logger.error(`[Network Stats] Error loading stats: ${error.message}. Initializing totals to 0.`);
        }
    }
}

async function saveStats() {
    try {
        const data = `${totalSent},${totalReceived}`; 
        await fs.writeFile(STATS_FILE, data, 'utf8');
        logger.debug(`[Network Stats] Totals saved successfully.`);
    } catch (error) {
        logger.error(`[Network Stats] Error saving stats: ${error.message}`);
    }
}

async function init() {
    await loadStats();
    saveIntervalId = setInterval(saveStats, SAVE_INTERVAL_MS);
    logger.info(`[Network Stats] Persistence initialized. Saving every ${SAVE_INTERVAL_MS / 1000} seconds.`);
}

async function shutdown() {
    if (saveIntervalId) {
        clearInterval(saveIntervalId);
    }
    logger.info('[Network Stats] Performing final save on shutdown...');
    await saveStats();
}

module.exports = {
    addSent,
    addReceived,
    getStats,
    init,
    shutdown
};