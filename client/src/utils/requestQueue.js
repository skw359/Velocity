// Bounded, cancellable queue for per-row background fetches (folder sizes, thumbnails),
// so they can't saturate the per-host connection pool and stall the next folder listing.

// Below the browser's ~6 connections per host, so the listing fetch and stat polls always have free slots.
const MAX_CONCURRENT = 4;

let activeCount = 0;
const waiting = [];
const inflight = new Set();  // AbortControllers of running tasks
let generation = 0;          // bumped on every navigation

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError'; // match fetch()'s abort shape so callers can treat it uniformly
  return err;
}

// Call on navigation so the folder being left stops competing for connections.
export function cancelBackgroundTasks() {
  generation++;
  while (waiting.length) {
    const task = waiting.shift();
    task.controller.abort();
    task.reject(abortError());
  }
  for (const controller of inflight) controller.abort();
  // inflight entries are removed as their promises settle in pump()'s finally().
}

function pump() {
  while (activeCount < MAX_CONCURRENT && waiting.length) {
    const task = waiting.shift();
    // Skip tasks from before a navigation or already cancelled, without spending a request.
    if (task.generation !== generation || task.controller.signal.aborted) {
      task.reject(abortError());
      continue;
    }
    activeCount++;
    inflight.add(task.controller);
    Promise.resolve()
      .then(() => task.run(task.controller.signal))
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount--;
        inflight.delete(task.controller);
        pump();
      });
  }
}

// `promise` rejects with an AbortError if cancelled; `cancel` drops just this task
// (e.g. when its row unmounts).
export function scheduleBackgroundTask(run) {
  const controller = new AbortController();
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    waiting.push({
      run,
      controller,
      generation,
      resolve: (v) => { settled = true; resolve(v); },
      reject: (e) => { settled = true; reject(e); },
    });
    pump();
  });
  const cancel = () => { if (!settled) controller.abort(); };
  return { promise, cancel };
}
