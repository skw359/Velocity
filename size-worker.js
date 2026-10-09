const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

async function getFolderSize(directoryPath) {
    let totalSize = 0;
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        // Use lstat to avoid following symlinks into potential recursion loops
        try {
            const stats = await fs.promises.lstat(fullPath);
            if (stats.isFile()) {
                totalSize += stats.size;
            } else if (stats.isDirectory()) {
                totalSize += await getFolderSize(fullPath);
            }
            // Symlinks, block devices, etc. are deliberately not counted.
        } catch (err) {
            console.error(`[Worker] Could not stat ${fullPath}: ${err.message}`);
        }
    }
    return totalSize;
}

parentPort.on('message', async (task) => {
    const { itemPath, taskId } = task;
    if (!itemPath || !taskId) return;

    try {
        const stats = await fs.promises.lstat(itemPath);
        let size = 0;

        if (stats.isFile()) {
            size = stats.size;
        } else if (stats.isDirectory()) {
            size = await getFolderSize(itemPath);
        }

        parentPort.postMessage({ taskId, size });
    } catch (err) {
        console.error(`[Worker] Error calculating size for ${itemPath}: ${err.message}`);
        // Post an error back so the frontend doesn't wait forever
        parentPort.postMessage({ taskId, error: err.message });
    }
});