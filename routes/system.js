// The dashboard widgets' polling endpoints.

const os = require('os');
const express = require('express');
const networkStats = require('../network-stats');
const bandwidth = require('../bandwidth');

module.exports = function systemRoutes() {
    const router = express.Router();

    router.get('/network-stats', (req, res) => res.json(networkStats.getStats()));

    // Lifetime upload/download byte totals (persist across restarts).
    router.get('/bandwidth', (req, res) => res.json(bandwidth.getStats()));

    router.get('/cpu-utilization', (req, res) => {
        const startCpus = os.cpus();
        setTimeout(() => {
            const endCpus = os.cpus();
            let totalIdle = 0, totalTick = 0;
            let startTotalIdle = 0, startTotalTick = 0;
            startCpus.forEach(cpu => {
                for (const type in cpu.times) startTotalTick += cpu.times[type];
                startTotalIdle += cpu.times.idle;
            });
            endCpus.forEach(cpu => {
                for (const type in cpu.times) totalTick += cpu.times[type];
                totalIdle += cpu.times.idle;
            });
            const idleDiff = totalIdle - startTotalIdle;
            const totalDiff = totalTick - startTotalTick;
            if (totalDiff === 0) return res.json({ utilization: 0 });
            const utilization = 100 * (1 - idleDiff / totalDiff);
            res.json({ utilization });
        }, 500);
    });

    return router;
};
