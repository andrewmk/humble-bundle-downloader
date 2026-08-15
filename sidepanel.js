let port = null;
let foundLinks = [];
let isQueueActive = false; // true while a download queue is running/queued

const scanArea = document.getElementById('scan-area');
const notOnHumble = document.getElementById('not-on-humble');
const linkList = document.getElementById('link-list');
const progressArea = document.getElementById('progress-area');
const doneArea = document.getElementById('done-area');

const scanBtn = document.getElementById('scan-btn');
const startBtn = document.getElementById('start-btn');
const rescanBtn = document.getElementById('rescan-btn');
const cancelBtn = document.getElementById('cancel-btn');
const restartBtn = document.getElementById('restart-btn');
const selectAllBtn = document.getElementById('select-all-btn');
const selectNoneBtn = document.getElementById('select-none-btn');

const linksScroll = document.getElementById('links-scroll');
const progressLinksScroll = document.getElementById('progress-links-scroll');
const linkCount = document.getElementById('link-count');
const progressBar = document.getElementById('progress-bar');
const progressFraction = document.getElementById('progress-fraction');
const currentFile = document.getElementById('current-file');
const fileProgressBar = document.getElementById('file-progress-bar');
const fileProgressFraction = document.getElementById('file-progress-fraction');
const fileProgressLabel = document.getElementById('file-progress-label');

function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

function connectPort() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handleProgress);
  port.onDisconnect.addListener(() => {
    port = null;
    // The service worker can be torn down and restarted by Chrome (e.g.
    // during a long-running download), which drops this port. Reconnect
    // so the panel picks the live state back up instead of going stale.
    setTimeout(connectPort, 250);
  });
  port.postMessage({ action: 'getProgress' });
}

function handleProgress(msg) {
  if (msg.type !== 'progress') return;

  if (msg.status === 'idle') { isQueueActive = false; return; }
  if (msg.status === 'queued') { isQueueActive = true; return; }

  if (msg.status === 'downloading' || msg.status === 'error') {
    isQueueActive = true;
    hide(scanArea); hide(doneArea); hide(linkList);
    show(progressArea);

    // If this panel wasn't around when the run started (opened mid-download,
    // or the service worker restarted), it never got a link list to build
    // the dots from — or it's showing a stale list from a prior run.
    // Rebuild whenever the signature of the run doesn't match what's shown.
    if (msg.items && msg.items.length) {
      const signature = msg.items.map(l => l.title).join('|');
      if (progressLinksScroll.dataset.signature !== signature) {
        renderProgressList(msg.items);
      }
    }

    const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
    progressBar.style.width = pct + '%';
    progressFraction.textContent = `${msg.done} / ${msg.total}`;
    currentFile.textContent = msg.current ? `Downloading: ${msg.current}` : '';

    updateFileProgress(msg.currentBytesReceived, msg.currentTotalBytes);

    // Update dots
    updateDots(msg.done, msg.current);
    return;
  }

  if (msg.status === 'done' || msg.status === 'cancelled') {
    isQueueActive = false;
    hide(scanArea); hide(progressArea);
    show(doneArea);
    updateFileProgress(0, 0);
    if (msg.status === 'cancelled') {
      doneArea.querySelector('.status-done').textContent = '⚠️ Downloads cancelled.';
    } else {
      doneArea.querySelector('.status-done').textContent = '✅ All downloads complete!';
    }
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function updateFileProgress(received, total) {
  received = received || 0;
  total = total || 0;

  if (total > 0) {
    const pct = Math.min(100, (received / total) * 100);
    fileProgressBar.style.width = pct + '%';
    fileProgressFraction.textContent = `${formatBytes(received)} / ${formatBytes(total)}`;
  } else {
    // Server didn't report a content length (or hasn't started yet) —
    // show received bytes without a meaningful percentage.
    fileProgressBar.style.width = received > 0 ? '100%' : '0%';
    fileProgressFraction.textContent = received > 0 ? formatBytes(received) : '';
  }
}

function updateDots(done, current) {
  // Only the progress-step list has dots; the scan-step list uses
  // checkboxes instead and is hidden once downloading starts.
  const items = progressLinksScroll.querySelectorAll('.link-item');
  let activeItem = null;
  items.forEach((item, i) => {
    const dot = item.querySelector('.link-dot');
    if (!dot) return;
    const name = item.dataset.name;
    dot.className = 'link-dot';
    if (i < done) {
      dot.classList.add('done');
    } else if (name === current) {
      dot.classList.add('active');
      activeItem = item;
    }
  });
  if (activeItem && progressLinksScroll.offsetParent !== null) {
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderLinks(links) {
  console.log("In renderLinks...");
  // Selectable checklist shown during the scan step.
  const selectMarkup = links.map((link, i) =>
    `<label class="link-item" data-name="${escHtml(link.title)}">
      <input type="checkbox" class="link-check" data-index="${i}" checked>
      <div class="link-name" title="${escHtml(displayTitle(link))}">${escHtml(displayTitle(link))}</div>
    </label>`
  ).join('');
  linksScroll.innerHTML = selectMarkup;
  linksScroll.querySelectorAll('.link-check').forEach(cb => {
    cb.addEventListener('change', updateSelectionUI);
  });

  updateSelectionUI();
}

function getSelectedLinks() {
  const checks = linksScroll.querySelectorAll('.link-check');
  return foundLinks.filter((_, i) => checks[i]?.checked);
}

function updateSelectionUI() {
  const selected = getSelectedLinks();
  linkCount.textContent = `${selected.length} / ${foundLinks.length}`;
  startBtn.disabled = selected.length === 0;
  startBtn.textContent = selected.length === foundLinks.length
    ? '⬇ Download All'
    : `⬇ Download Selected (${selected.length})`;
}

function renderProgressList(links) {
  // Static (non-checkbox) dot list shown once downloads start.
  progressLinksScroll.dataset.signature = links.map(l => l.title).join('|');
  const markup = links.map(link =>
    `<div class="link-item" data-name="${escHtml(link.title)}"><div class="link-dot"></div><div class="link-name" title="${escHtml(displayTitle(link))}">${escHtml(displayTitle(link))}</div></div>`
  ).join('');
  progressLinksScroll.innerHTML = markup;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getExtensionLabel(url) {
  // Mirrors the extension-detection in background.js, so the badge shown
  // here always matches what the file is actually saved as.
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]{1,6})$/i);
    return match ? match[1].toUpperCase() : '';
  } catch {
    return '';
  }
}

function displayTitle(link) {
  const ext = getExtensionLabel(link.url);
  return ext ? `${link.title} (${ext})` : link.title;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scanPage() {
  const tab = await getActiveTab();
  const url = tab?.url || '';

  if (!url.includes('humblebundle.com')) {
    hide(scanArea);
    show(notOnHumble);
    console.log("Not on humblebundle.com page");
    return;
  }

  scanBtn.disabled = true;
  scanBtn.textContent = '⏳ Scanning...';
  console.log("Scanning...");

  try {
    console.log("Sending message to content script...");
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'getDownloadLinks' });
    foundLinks = results?.links || [];
    console.log("Got links: " + foundLinks.length);
  } catch(e) {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'getDownloadLinks' });
    foundLinks = results?.links || [];
  }

  scanBtn.disabled = false;
  scanBtn.textContent = '🔍 Scan for Links';

  if (foundLinks.length === 0) {
    scanBtn.textContent = '⚠️ Nothing found — try rescan';
    return;
  }

  renderLinks(foundLinks);
  hide(scanArea);
  show(linkList);
}

scanBtn.addEventListener('click', scanPage);

rescanBtn.addEventListener('click', () => {
  hide(linkList);
  show(scanArea);
  scanPage();
});

selectAllBtn.addEventListener('click', () => {
  linksScroll.querySelectorAll('.link-check').forEach(cb => cb.checked = true);
  updateSelectionUI();
});

selectNoneBtn.addEventListener('click', () => {
  linksScroll.querySelectorAll('.link-check').forEach(cb => cb.checked = false);
  updateSelectionUI();
});

startBtn.addEventListener('click', () => {
  const selected = getSelectedLinks();
  if (selected.length === 0) return;

  if (!port) connectPort();
  renderProgressList(selected);
  port.postMessage({ action: 'startQueue', links: selected });
  show(progressArea);
  progressBar.style.width = '0%';
  progressFraction.textContent = `0 / ${selected.length}`;
  currentFile.textContent = '';
  updateFileProgress(0, 0);
});

cancelBtn.addEventListener('click', () => {
  if (port) port.postMessage({ action: 'cancelQueue' });
});

restartBtn.addEventListener('click', () => {
  hide(doneArea); hide(progressArea);
  foundLinks = [];
  show(scanArea);
  scanBtn.textContent = '🔍 Scan for Links';
  if (port) port.postMessage({ action: 'acknowledgeDone' });
});

function refreshHumbleState(tab) {
  // Never touch the UI while a download queue is running or queued —
  // switching tabs (even away from Humble Bundle) must not interrupt it
  // or change what's on screen.
  if (isQueueActive) return;

  // Also leave the link list / done screen alone; only the initial
  // scan step reacts to tab changes.
  const inScanStep = scanArea.style.display !== 'none' || notOnHumble.style.display !== 'none';
  if (!inScanStep) return;

  if (tab && tab.url && tab.url.includes('humblebundle.com')) {
    hide(notOnHumble);
    show(scanArea);
  } else {
    hide(scanArea);
    show(notOnHumble);
  }
}

// On open, connect and check if a download is already running before
// touching the UI based on the active tab, to avoid a race where the
// tab-based check runs before we know a queue is active.
connectPort();
port.onMessage.addListener(function initialSync(msg) {
  if (msg.type !== 'progress') return;
  port.onMessage.removeListener(initialSync);
  getActiveTab().then(refreshHumbleState);
});

// The side panel stays open across tab switches and navigation, so keep
// the "are we on Humble Bundle" state live instead of only checking once.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(refreshHumbleState).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    getActiveTab().then(activeTab => {
      if (activeTab && activeTab.id === tabId) refreshHumbleState(tab);
    });
  }
});
