// Background service worker: manages the sequential download queue

let queue = [];
let isDownloading = false;
let currentDownloadId = null;
let popupPort = null;
let progress = { done: 0, total: 0, current: '', status: 'idle' };

function broadcastProgress() {
  if (popupPort) {
    try { popupPort.postMessage({ type: 'progress', ...progress }); } catch {}
  }
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
  broadcastProgress();

  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: sanitizeFilename(item.title) + '.pdf',
      saveAs: false,
      conflictAction: 'uniquify'
    });
    currentDownloadId = downloadId;
  } catch (err) {
    console.error('Download failed:', err);
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
    queue.shift();
    progress.done++;
    isDownloading = false;
    currentDownloadId = null;
    broadcastProgress();
    downloadNext();
  } else if (state === 'interrupted') {
    console.warn('Download interrupted:', delta);
    queue.shift();
    progress.done++;
    isDownloading = false;
    currentDownloadId = null;
    progress.status = 'error';
    broadcastProgress();
    downloadNext();
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    popupPort = port;
    port.postMessage({ type: 'progress', ...progress });

    port.onMessage.addListener((msg) => {
      if (msg.action === 'startQueue') {
        queue = msg.links.slice();
        progress = { done: 0, total: queue.length, current: '', status: 'queued' };
        isDownloading = false;
        currentDownloadId = null;
        broadcastProgress();
        downloadNext();
      } else if (msg.action === 'cancelQueue') {
        queue = [];
        if (currentDownloadId !== null) {
          chrome.downloads.cancel(currentDownloadId);
          currentDownloadId = null;
        }
        isDownloading = false;
        progress.status = 'cancelled';
        broadcastProgress();
      } else if (msg.action === 'getProgress') {
        port.postMessage({ type: 'progress', ...progress });
      }
    });

    port.onDisconnect.addListener(() => {
      popupPort = null;
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
