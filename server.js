// Entry point (`npm start`, the systemd unit): starts Velocity and owns process-level
// concerns, signals and fatal errors. The server itself is assembled in app.js.

const logger = require('./logger');
const app = require('./app');
const { installProcessGuards } = require('./process-guard');

let instance = null;
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.rule(`shutdown · ${reason}`);
    const forceExit = setTimeout(() => process.exit(exitCode || 1), 5000);
    try {
        await app.stop(instance);
        clearTimeout(forceExit);
        logger.rule('');
        process.exit(exitCode);
    } catch (error) {
        logger.step(`Shutdown failed: ${error.message}`, 'fail');
        clearTimeout(forceExit);
        logger.rule('');
        process.exit(1);
    }
}

installProcessGuards({ logger, onFatal: (kind) => shutdown(kind, 1) });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.start()
    .then((started) => { instance = started; })
    .catch((error) => {
        logger.error(`[Server Start] Failed: ${error.stack || error.message}`);
        process.exit(1);
    });
