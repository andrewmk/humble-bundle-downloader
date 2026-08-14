let port = null;
let foundLinks = [];

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

const linksScroll = document.getElementById('links-scroll');
const linkCount = document.getElementById('link-count');
const progressBar = document.getElementById('progress-bar');
const progressFraction = document.getElementById('progress-fraction');
const currentFile = document.getElementById('current-file');

function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handleProgress);
  port.onDisconnect.addListener(() => { port = null; });
  port.postMessage({ action: 'getProgress' });
}

function handleProgress(msg) {
  if (msg.type !== 'progress') return;

  if (msg.status === 'idle' || msg.status === 'queued') return;

  if (msg.status === 'downloading' || msg.status === 'error') {
    hide(scanArea); hide(doneArea);
    show(progressArea);

    const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
    progressBar.style.width = pct + '%';
    progressFraction.textContent = `${msg.done} / ${msg.total}`;
    currentFile.textContent = msg.current ? `Downloading: ${msg.current}` : '';

    // Update dots
    updateDots(msg.done, msg.current);
    return;
  }

  if (msg.status === 'done' || msg.status === 'cancelled') {
    hide(scanArea); hide(progressArea);
    show(doneArea);
    if (msg.status === 'cancelled') {
      doneArea.querySelector('.status-done').textContent = '⚠️ Downloads cancelled.';
    } else {
      doneArea.querySelector('.status-done').textContent = '✅ All downloads complete!';
    }
  }
}

function updateDots(done, current) {
  const items = linksScroll.querySelectorAll('.link-item');
  items.forEach((item, i) => {
    const dot = item.querySelector('.link-dot');
    const name = item.dataset.name;
    dot.className = 'link-dot';
    if (i < done) dot.classList.add('done');
    else if (name === current) dot.classList.add('active');
  });
}

function renderLinks(links) {
  console.log("In renderLinks...");
  linksScroll.innerHTML = '';
  links.forEach(link => {
    const div = document.createElement('div');
    div.className = 'link-item';
    div.dataset.name = link.title;
    div.innerHTML = `<div class="link-dot"></div><div class="link-name" title="${escHtml(link.title)}">${escHtml(link.title)}</div>`;
    linksScroll.appendChild(div);
  });
  linkCount.textContent = links.length;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'getPdfLinks' });
    foundLinks = results?.links || [];
    console.log("Got links: " + foundLinks.length);
  } catch(e) {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'getPdfLinks' });
    foundLinks = results?.links || [];
  }

  scanBtn.disabled = false;
  scanBtn.textContent = '🔍 Scan for PDF Links';

  if (foundLinks.length === 0) {
    scanBtn.textContent = '⚠️ No PDFs found — try rescan';
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

startBtn.addEventListener('click', () => {
  if (!port) connectPort();
  port.postMessage({ action: 'startQueue', links: foundLinks });
  show(progressArea);
  progressBar.style.width = '0%';
  progressFraction.textContent = `0 / ${foundLinks.length}`;
  currentFile.textContent = '';
});

cancelBtn.addEventListener('click', () => {
  if (port) port.postMessage({ action: 'cancelQueue' });
});

restartBtn.addEventListener('click', () => {
  hide(doneArea); hide(progressArea);
  foundLinks = [];
  show(scanArea);
  scanBtn.textContent = '🔍 Scan for PDF Links';
});

// On open, connect and check if a download is already running
connectPort();
getActiveTab().then(tab => {
  if (tab && !tab.url.includes('humblebundle.com')) {
    hide(scanArea);
    show(notOnHumble);
  }
});
