// Walks one file or folder tree and reports { size, files }. lstat throughout: symlinks are
// neither followed nor counted, so a link can't lead the walk outside the tree or around in
// a loop. Unreadable entries are skipped, so one locked folder doesn't zero the total.

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const BATCH = 32; // concurrent lstat calls per directory

async function measure(root) {
    const rootStats = await fs.promises.lstat(root);
    if (rootStats.isFile()) return { size: rootStats.size, files: 1 };
    if (!rootStats.isDirectory()) return { size: 0, files: 0 };

    let size = 0;
    let files = 0;
    // Iterative, so a very deep tree can't overflow the stack.
    const dirs = [root];
    while (dirs.length) {
        const dir = dirs.pop();
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (let i = 0; i < entries.length; i += BATCH) {
            await Promise.all(entries.slice(i, i + BATCH).map(async (entry) => {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    dirs.push(full);
                    return;
                }
                if (!entry.isFile()) return; // symlinks, devices, sockets
                let stats;
                try {
                    stats = await fs.promises.lstat(full);
                } catch {
                    return; // vanished mid-walk
                }
                // Added after the await: `size += await ...` would read `size` before it,
                // and concurrent lstats would overwrite each other's additions.
                size += stats.size;
                files++;
            }));
        }
    }
    return { size, files };
}

parentPort.on('message', async (task) => {
    const { itemPath, taskId } = task || {};
    if (!itemPath || !taskId) return;
    try {
        parentPort.postMessage({ taskId, ...(await measure(itemPath)) });
    } catch (err) {
        // Answered either way, so the request waiting on it never hangs.
        parentPort.postMessage({ taskId, error: err.message });
    }
});
