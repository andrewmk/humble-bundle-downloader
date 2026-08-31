// Reproduce test 10 setup and dump state after loadWorker
const fs = require('fs');
const vm = require('vm');
const BG = '../background.js';

const downloads = new Map();
let nextDownloadId = 1;
const sessionStore = {};
const localStore = { maxParallel: 2 };
let downloadListeners = [], storageListeners = [], connectListeners = [];
let timers = new Set();

function fire(delta) { for (const fn of [...downloadListeners]) fn(delta); }

function loadWorker() {
  timers.clear();
  downloadListeners = []; storageListeners = []; connectListeners = [];
  const sandbox = {
    chrome: {
      sidePanel: { setPanelBehavior: () => Promise.resolve() },
      downloads: {
        download: async (opts) => {
          const id = nextDownloadId++;
          downloads.set(id, { id, url: opts.url, state: 'in_progress', bytesReceived: 0, totalBytes: 512 });
          console.log('  [chrome.downloads.download called for', opts.url, '-> id', id + ']');
          return id;
        },
        search: async ({ id, url }) => {
          const out = [];
          for (const d of downloads.values()) {
            if (id !== undefined && d.id === id) out.push(d);
            else if (id === undefined && url && d.url.includes(url)) out.push(d);
          }
          return out;
        },
        cancel: (id) => Promise.resolve().then(() => {
          const d = downloads.get(id);
          if (!d || d.state !== 'in_progress') return;
          d.state = 'interrupted';
          fire({ id, state: { current: 'interrupted' } });
        }),
        onChanged: { addListener: (fn) => downloadListeners.push(fn) },
      },
      storage: {
        session: {
          set: async (o) => Object.assign(sessionStore, o),
          get: async (k) => ({ [k]: sessionStore[k] }),
        },
        local: {
          set: async (o) => { for (const [k,v] of Object.entries(o)) { localStore[k] = v; for (const fn of [...storageListeners]) fn({[k]:{newValue:v}}, 'local'); } },
          get: async (k) => ({ [k]: localStore[k] }),
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
      },
      runtime: { onConnect: { addListener: (fn) => connectListeners.push(fn) } },
    },
    console,
    setInterval: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearInterval: (t) => { if (t) timers.delete(t); },
  };
  vm.runInContext(fs.readFileSync(BG, 'utf8'), vm.createContext(sandbox));
}

(async () => {
  const links = (n) => Array.from({ length: n }, (_, i) => ({
    title: `Book ${String.fromCharCode(65 + i)}`,
    url: `https://cdn.humble.com/lib/book-${i}.pdf`,
  }));

  downloads.set(1, { id: 1, url: 'https://cdn.humble.com/lib/book-0.pdf', state: 'in_progress', bytesReceived: 100, totalBytes: 512 });
  downloads.set(2, { id: 2, url: 'https://cdn.humble.com/lib/book-1.pdf', state: 'in_progress', bytesReceived: 50, totalBytes: 512 });
  sessionStore.downloadQueueState = {
    queue: [
      { title: 'Book C', url: 'https://cdn.humble.com/lib/book-2.pdf' },
      { title: 'Book D', url: 'https://cdn.humble.com/lib/book-3.pdf' },
    ],
    inFlight: [[1, { title: 'Book A', url: 'https://cdn.humble.com/lib/book-0.pdf', bytesReceived: 100, totalBytes: 512 }]],
    starting: [{ title: 'Book B', url: 'https://cdn.humble.com/lib/book-1.pdf' }],
    allItems: links(4),
    progress: { done: 0, total: 4, status: 'downloading', completed: [] },
  };

  loadWorker();
  await new Promise(r => setTimeout(r, 100));
  console.log('downloads map:');
  for (const d of downloads.values()) console.log('  ', d.id, d.url, d.state);
  console.log('session state:', JSON.stringify(sessionStore.downloadQueueState, null, 1).slice(0, 600));
})();
