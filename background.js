// Background service worker: manages the sequential download queue
//
// IMPORTANT: MV3 service workers can be terminated by Chrome after ~30s of
// inactivity, including mid-download while waiting on a large file. Chrome
// re-wakes the worker for genuine extension events like
// chrome.downloads.onChanged, so the download itself (tracked natively by
// Chrome's download manager) keeps going. But all in-memory state here is
// wiped on restart, so we persist the queue/progress to session storage and
// restore it on startup, and any connected panels reconnect their ports.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

let queue = [];
let isDownloading = false;
let currentDownloadId = null;
const panelPorts = new Set();
let progress = {
  done: 0, total: 0, current: '', status: 'idle',
  currentBytesReceived: 0, currentTotalBytes: 0
};
let pollTimer = null;

const STATE_KEY = 'downloadQueueState';

async function persistState() {
  try {
    await chrome.storage.session.set({
      [STATE_KEY]: { queue, progress, currentDownloadId }
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
    progress = saved.progress || progress;
    currentDownloadId = saved.currentDownloadId ?? null;
    isDownloading = false;

    if (currentDownloadId !== null) {
      // A download may have finished (or failed) while the worker was
      // asleep. Check its actual state rather than assuming it's still
      // running, since we won't have missed the onChanged event that
      // would've woken us — but we may have missed intermediate ones.
      const [item] = await chrome.downloads.search({ id: currentDownloadId });
      if (!item || item.state === 'complete') {
        queue.shift();
        progress.done++;
        currentDownloadId = null;
        progress.currentBytesReceived = 0;
        progress.currentTotalBytes = 0;
        await persistState();
        downloadNext();
      } else if (item.state === 'interrupted') {
        queue.shift();
        progress.done++;
        currentDownloadId = null;
        progress.status = 'error';
        progress.currentBytesReceived = 0;
        progress.currentTotalBytes = 0;
        await persistState();
        downloadNext();
      } else {
        // Still in_progress: resume polling so per-file progress keeps
        // updating; onChanged will fire normally when it settles.
        progress.currentBytesReceived = item.bytesReceived;
        progress.currentTotalBytes = item.totalBytes;
        startPolling(currentDownloadId);
      }
    } else if (queue.length > 0) {
      // Queue exists but nothing was in flight — resume it.
      downloadNext();
    }
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

restoreState();

function broadcastProgress() {
  persistState();
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'progress', ...progress }); } catch {}
  }
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(downloadId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (currentDownloadId !== downloadId) { stopPolling(); return; }
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item) return;
      // in_progress items report live bytesReceived/totalBytes; other
      // states are handled by the onChanged listener, not here.
      if (item.state === 'in_progress') {
        progress.currentBytesReceived = item.bytesReceived;
        progress.currentTotalBytes = item.totalBytes; // 0/-1 if unknown (e.g. chunked response)
        broadcastProgress();
      }
    } catch (err) {
      console.error('Progress poll failed:', err);
    }
  }, 500);
}

async function downloadNext() {
  if (isDownloading || queue.length === 0) {
    if (queue.length === 0 && progress.total > 0) {
      progress.status = 'done';
      broadcastProgress();
    }
    return;
  }

  isDownloading = true;
  const item = queue[0];
  progress.current = item.title;
  progress.status = 'downloading';
  progress.currentBytesReceived = 0;
  progress.currentTotalBytes = 0;
  broadcastProgress();

  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: sanitizeFilename(item.title) + '.pdf',
      saveAs: false,
      conflictAction: 'uniquify'
    });
    currentDownloadId = downloadId;
    await persistState();
    startPolling(downloadId);
  } catch (err) {
    console.error('Download failed:', err);
    stopPolling();
    queue.shift();
    progress.done++;
    isDownloading = false;
    currentDownloadId = null;
    progress.status = 'error';
    broadcastProgress();
    downloadNext();
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.id !== currentDownloadId) return;

  const state = delta.state?.current;

  if (state === 'complete') {
    stopPolling();
    queue.shift();
    progress.done++;
    isDownloading = false;
    currentDownloadId = null;
    progress.currentBytesReceived = 0;
    progress.currentTotalBytes = 0;
    broadcastProgress();
    downloadNext();
  } else if (state === 'interrupted') {
    console.warn('Download interrupted:', delta);
    stopPolling();
    queue.shift();
    progress.done++;
    isDownloading = false;
    currentDownloadId = null;
    progress.status = 'error';
    progress.currentBytesReceived = 0;
    progress.currentTotalBytes = 0;
    broadcastProgress();
    downloadNext();
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    panelPorts.add(port);
    port.postMessage({ type: 'progress', ...progress });

    port.onMessage.addListener((msg) => {
      if (msg.action === 'startQueue') {
        stopPolling();
        queue = msg.links.slice();
        progress = {
          done: 0, total: queue.length, current: '', status: 'queued',
          currentBytesReceived: 0, currentTotalBytes: 0
        };
        isDownloading = false;
        currentDownloadId = null;
        broadcastProgress();
        downloadNext();
      } else if (msg.action === 'cancelQueue') {
        stopPolling();
        queue = [];
        if (currentDownloadId !== null) {
          chrome.downloads.cancel(currentDownloadId);
          currentDownloadId = null;
        }
        isDownloading = false;
        progress.status = 'cancelled';
        progress.currentBytesReceived = 0;
        progress.currentTotalBytes = 0;
        broadcastProgress();
      } else if (msg.action === 'getProgress') {
        port.postMessage({ type: 'progress', ...progress });
      }
    });

    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
    });
  }
});

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180)
    || 'humble_pdf';
}
