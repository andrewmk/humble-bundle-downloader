const fs = require('fs');
const vm = require('vm');
const BG = '../background.js';

const downloads = new Map();
let nextDownloadId = 1;
const sessionStore = {};
const localStore = {};
let downloadListeners = [], storageListeners = [], connectListeners = [];

const sandbox = {
  chrome: {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    downloads: {
      download: async (opts) => {
        const id = nextDownloadId++;
        downloads.set(id, { id, url: opts.url, state: 'in_progress', bytesReceived: 0, totalBytes: 512 });
        return id;
      },
      search: async ({ id }) => (downloads.has(id) ? [downloads.get(id)] : []),
      cancel: (id) => Promise.resolve().then(() => {
        const d = downloads.get(id);
        if (!d) return;
        d.state = 'interrupted';
        for (const fn of downloadListeners) fn({ id, state: { current: 'interrupted' } });
      }),
      onChanged: { addListener: (fn) => downloadListeners.push(fn) },
    },
    storage: {
      session: {
        set: async (o) => Object.assign(sessionStore, o),
        get: async (k) => ({ [k]: sessionStore[k] }),
      },
      local: {
        set: async (o) => { for (const [k,v] of Object.entries(o)) { localStore[k] = v; for (const fn of storageListeners) fn({[k]:{newValue:v}}, 'local'); } },
        get: async (k) => ({ [k]: localStore[k] }),
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    runtime: { onConnect: { addListener: (fn) => connectListeners.push(fn) } },
  },
  console,
  setInterval: () => 1,
  clearInterval: () => {},
};

try {
  vm.runInContext(fs.readFileSync(BG, 'utf8'), vm.createContext(sandbox));
} catch (e) {
  console.error('LOAD ERROR:', e);
}

(async () => {
  await new Promise(r => setTimeout(r, 50));
  const port = {
    name: 'sidepanel',
    onMessage: { addListener: (fn) => { port.handle = fn; } },
    onDisconnect: { addListener: () => {} },
    messages: [],
    postMessage: (m) => port.messages.push(m),
  };
  connectListeners[0](port);
  await new Promise(r => setTimeout(r, 50));
  console.log('connect msg:', JSON.stringify(port.messages.at(-1)));
  port.handle({ action: 'startQueue', links: [
    { title: 'Book A', url: 'https://cdn.humble.com/lib/book-0.pdf' },
    { title: 'Book B', url: 'https://cdn.humble.com/lib/book-1.pdf' },
  ]});
  await new Promise(r => setTimeout(r, 100));
  console.log('downloads:', [...downloads.values()].map(d => ({ id: d.id, state: d.state })));
  console.log('msgs:', port.messages.map(m => JSON.stringify({ status: m.status, done: m.done, active: m.active.length })));
  console.log('session state:', JSON.stringify(sessionStore.downloadQueueState)?.slice(0, 400));
})();
