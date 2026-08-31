// Background service worker: manages the download queue, downloading up to
// `maxParallel` files at a time. The limit is configurable from the side
// panel's Settings screen (stored in chrome.storage.local).
//
// IMPORTANT: MV3 service workers can be terminated by Chrome after ~30s of
// inactivity, including mid-download while waiting on a large file. Chrome
// re-wakes the worker for genuine extension events like
// chrome.downloads.onChanged, so the downloads themselves (tracked natively
// by Chrome's download manager) keep going. But all in-memory state here is
// wiped on restart, so we persist the queue/progress to session storage and
// restore it on startup, and any connected panels reconnect their ports.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// --- settings ---

const SETTINGS_KEY = 'maxParallel';
const DEFAULT_MAX_PARALLEL = 4;
const MAX_PARALLEL_LIMIT = 8;

function clampMaxParallel(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PARALLEL;
  return Math.min(MAX_PARALLEL_LIMIT, Math.max(1, n));
}

let maxParallel = DEFAULT_MAX_PARALLEL;

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    maxParallel = clampMaxParallel(stored[SETTINGS_KEY]);
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// The Settings screen writes the new limit to local storage. React here so
// the change applies without a reload — including to a run that's already in
// progress (raising the limit starts more queued downloads right away).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const next = clampMaxParallel(changes[SETTINGS_KEY].newValue);
  if (next === maxParallel) return;
  maxParallel = next;
  console.log(`Simultaneous downloads set to ${next}`);
  if (isDownloading) advanceQueue();
});

// --- queue state ---

let queue = [];            // items waiting for a free download slot
let inFlight = new Map();  // chrome downloadId -> { title, url, bytesReceived, totalBytes }
let starting = new Set();  // items whose chrome.downloads.download() call is still pending
let allItems = [];         // full original list for the active run, for panels that (re)connect mid-download
let isDownloading = false; // true while a run is active (anything queued or in flight)
const panelPorts = new Set();
let progress = { done: 0, total: 0, status: 'idle', completed: [] };
let pollTimer = null;

const STATE_KEY = 'downloadQueueState';

async function persistState() {
  try {
    await chrome.storage.session.set({
      [STATE_KEY]: {
        queue,
        inFlight: Array.from(inFlight.entries()),
        starting: [...starting],
        allItems,
        progress,
      }
    });
  } catch (err) {
    console.error('Failed to persist state:', err);
  }
}

async function restoreState() {
  try {
    const stored = await chrome.storage.session.get(STATE_KEY);
    const saved = stored?.[STATE_KEY];
    if (!saved) return;

    queue = saved.queue || [];
    allItems = saved.allItems || [];
    progress = saved.progress || progress;
    inFlight = new Map(saved.inFlight || []);
    starting = new Set();
    isDownloading = false;

    const wasRunning =
      progress.status === 'queued' ||
      progress.status === 'downloading' ||
      progress.status === 'error';
    if (!wasRunning) return;

    // A download may have finished (or failed) while the worker was asleep.
    // Check each in-flight download's actual state rather than assuming it's
    // still running, since we may have missed the onChanged events that
    // would have settled them.
    const stillActive = new Map();
    for (const item of starting) {
      // Its download call was in flight when the worker died, so we never
      // learned the download id. The download may have started in Chrome
      // anyway — adopt it if we can find it, otherwise start it again.
      let dl = null;
      try {
        const results = await chrome.downloads.search({ url: item.url });
        dl = results.find(r => r.state === 'in_progress' || r.state === 'complete') || null;
      } catch (err) {
        console.error('Failed to look up pending download:', err);
      }
      if (dl && dl.state === 'complete') {
        progress.done++;
        progress.completed.push(item.title);
      } else if (dl) {
        stillActive.set(dl.id, {
          title: item.title, url: item.url,
          bytesReceived: dl.bytesReceived, totalBytes: dl.totalBytes,
        });
      } else {
        queue.unshift(item);
      }
    }
    starting.clear();

    for (const [id, item] of inFlight) {
      const [dl] = await chrome.downloads.search({ id });
      if (!dl || dl.state === 'complete') {
        progress.done++;
        progress.completed.push(item.title);
      } else if (dl.state === 'interrupted') {
        progress.done++;
        progress.completed.push(item.title);
        progress.status = 'error';
      } else {
        // Still in_progress: carry its byte counters over so per-file
        // progress keeps updating; onChanged will fire normally on settle.
        stillActive.set(id, {
          ...item,
          bytesReceived: dl.bytesReceived,
          totalBytes: dl.totalBytes,
        });
      }
    }
    inFlight = stillActive;
    console.log('RESTORE: stillActive =', JSON.stringify([...stillActive.keys()]), 'queue =', JSON.stringify(queue.map(q => q.title)));
    await persistState();

    if (queue.length > 0 || inFlight.size > 0) {
      isDownloading = true;
      if (inFlight.size > 0) startPolling();
      advanceQueue();
    }
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

(async () => {
  await loadSettings();
  await restoreState();
})();

// --- progress reporting ---

function buildProgressMessage() {
  const active = [];
  for (const item of inFlight.values()) {
    active.push({
      title: item.title,
      url: item.url,
      bytesReceived: item.bytesReceived || 0,
      totalBytes: item.totalBytes || 0,
    });
  }
  return {
    type: 'progress',
    done: progress.done,
    total: progress.total,
    status: progress.status,
    active,
    completed: progress.completed.slice(),
    items: allItems,
  };
}

function broadcastProgress() {
  persistState();
  const msg = buildProgressMessage();
  for (const port of panelPorts) {
    try { port.postMessage(msg); } catch {}
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollInFlight, 500);
}

async function pollInFlight() {
  if (inFlight.size === 0) { stopPolling(); return; }
  for (const [id, item] of [...inFlight]) {
    try {
      const [dl] = await chrome.downloads.search({ id });
      if (!dl) continue;
      // in_progress items report live bytesReceived/totalBytes; other
      // states are handled by the onChanged listener, not here.
      if (dl.state === 'in_progress') {
        item.bytesReceived = dl.bytesReceived;
        item.totalBytes = dl.totalBytes; // 0/-1 if unknown (e.g. chunked response)
      }
    } catch (err) {
      console.error('Progress poll failed:', err);
    }
  }
  broadcastProgress();
}

// --- queue management (up to maxParallel downloads at once) ---

// Fill every free download slot from the queue. Called when a run starts,
// whenever a download settles (freeing a slot), and whenever the parallelism
// limit increases mid-run. `starting` is counted as busy too: a slot is held
// from the moment we kick off a download until it's registered or fails, so
// the run can never be declared finished while starts are still pending.
function advanceQueue() {
  if (!isDownloading) return;

  while (inFlight.size + starting.size < maxParallel && queue.length > 0) {
    const item = queue.shift();
    starting.add(item);
    startDownload(item);
  }

  console.log('ADVANCE: inFlight', inFlight.size, 'starting', starting.size, 'queue', queue.length, 'max', maxParallel);
  if (queue.length === 0 && inFlight.size === 0 && starting.size === 0) {
    finishRun();
  }
}

function finishRun() {
  isDownloading = false;
  progress.status = 'done';
  stopPolling();
  broadcastProgress();
}

async function startDownload(item) {
  progress.status = 'downloading';
  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: sanitizeFilename(item.title) + getExtension(item.url),
      saveAs: false,
      conflictAction: 'uniquify'
    });

    starting.delete(item);

    // The run may have been cancelled while the download call was pending;
    // don't resurrect it.
    if (!isDownloading) {
      chrome.downloads.cancel(downloadId).catch(() => {});
      return;
    }

    inFlight.set(downloadId, {
      title: item.title, url: item.url, bytesReceived: 0, totalBytes: 0
    });
    await persistState();
    startPolling();
    broadcastProgress();
  } catch (err) {
    starting.delete(item);
    console.error('Download failed:', err);
    // Count the failed start as handled and keep the queue moving (same
    // behavior the old sequential code had for a failed download).
    progress.done++;
    progress.completed.push(item.title);
    progress.status = 'error';
    broadcastProgress();
    advanceQueue();
  }
}

// Settle a finished/failed download: update counters, then fill the freed
// slot. Guarded so a download can never be counted twice.
function settleDownload(downloadId, completed) {
  if (!inFlight.has(downloadId)) return;
  const item = inFlight.get(downloadId);
  inFlight.delete(downloadId);

  progress.done++;
  progress.completed.push(item.title);
  progress.status = completed ? 'downloading' : 'error';
  if (!completed) console.warn('Download interrupted:', item.title);

  broadcastProgress();
  advanceQueue();
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!inFlight.has(delta.id)) return;

  const state = delta.state?.current;
  if (state === 'complete') {
    settleDownload(delta.id, true);
  } else if (state === 'interrupted') {
    settleDownload(delta.id, false);
  }
});

// --- side panel connections ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);
  port.postMessage(buildProgressMessage());

  port.onMessage.addListener((msg) => {
    if (msg.action === 'startQueue') {
      stopPolling();
      queue = msg.links.slice();
      allItems = msg.links.slice();
      inFlight = new Map();
      starting = new Set();
      progress = {
        done: 0, total: queue.length, status: 'queued', completed: []
      };
      isDownloading = true;
      broadcastProgress();
      advanceQueue();
    } else if (msg.action === 'cancelQueue') {
      isDownloading = false;
      queue = [];
      stopPolling();
      for (const id of [...inFlight.keys()]) {
        chrome.downloads.cancel(id).catch(() => {});
      }
      inFlight = new Map();
      starting.clear();
      progress.status = 'cancelled';
      broadcastProgress();
    } else if (msg.action === 'getProgress') {
      port.postMessage(buildProgressMessage());
    } else if (msg.action === 'acknowledgeDone') {
      // User dismissed the done/cancelled screen ("Start over"). Reset to
      // idle so this terminal status doesn't keep reappearing on future
      // reconnects (new panel opens, service-worker restarts, etc).
      if (progress.status === 'done' || progress.status === 'cancelled') {
        stopPolling();
        queue = [];
        allItems = [];
        inFlight = new Map();
        starting.clear();
        isDownloading = false;
        progress = { done: 0, total: 0, status: 'idle', completed: [] };
        broadcastProgress();
      }
    }
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
  });
});

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180)
    || 'humble_download';
}

function getExtension(url) {
  // Comics and books come in many formats (pdf, epub, mobi, cbz, cbr...);
  // pull the real extension from the download URL instead of assuming one.
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]{1,6})$/i);
    return match ? '.' + match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}
