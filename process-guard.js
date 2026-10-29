// What happens to an error that escaped everything else.
//
// A failed system call that surfaced as a stray 'error' event (a file locked mid-copy, a
// dropped connection) is operational: it is logged and the server carries on, since no
// code was interrupted halfway. Anything else (a TypeError, a broken invariant) means the
// process may be in a state nobody planned for, so it shuts down cleanly and exits
// non-zero, and its supervisor (systemd's Restart=on-failure) starts a fresh one.

const OPERATIONAL_CODES = new Set([
  'EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EEXIST', 'ENOTEMPTY', 'EXDEV', 'EISDIR', 'ENOTDIR',
  'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'EAGAIN',
  'EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECANCELED',
]);

// System-call errors carry the call's name; errors the code threw itself don't.
function isOperationalError(err) {
  return !!err && typeof err === 'object' && typeof err.syscall === 'string' && OPERATIONAL_CODES.has(err.code);
}

// onFatal(kind) runs once, for the first error that isn't operational.
function installProcessGuards({ logger, onFatal }) {
  let fatal = false;
  const handler = (kind) => (err) => {
    const text = err && err.stack ? err.stack : String(err);
    if (isOperationalError(err)) {
      logger.error(`[${kind}] Operational error, continuing: ${text}`);
      return;
    }
    logger.error(`[${kind}] Fatal, shutting down: ${text}`);
    if (fatal) return;
    fatal = true;
    onFatal(kind, err);
  };
  process.on('uncaughtException', handler('UncaughtException'));
  process.on('unhandledRejection', handler('UnhandledRejection'));
}

module.exports = { isOperationalError, installProcessGuards };
