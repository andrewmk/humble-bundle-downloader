// Same as debug2 but with an instrumented background.js
const fs = require('fs');
const vm = require('vm');
let BG = fs.readFileSync('../background.js', 'utf8');
BG = BG.replace(
  "    inFlight = stillActive;\n    await persistState();",
  "    inFlight = stillActive;\n    console.log('RESTORE: stillActive =', JSON.stringify([...stillActive.keys()]), 'queue =', JSON.stringify(queue.map(q => q.title)));\n    await persistState();"
).replace(
  "  if (queue.length === 0 && inFlight.size === 0 && starting.size === 0) {\n    finishRun();",
  "  console.log('ADVANCE: inFlight', inFlight.size, 'starting', starting.size, 'queue', queue.length, 'max', maxParallel);\n  if (queue.length === 0 && inFlight.size === 0 && starting.size === 0) {\n    finishRun();"
);
fs.writeFileSync('/tmp/hbd-test/background-instr.js', BG);

const downloads = new Map();
let nextDownloadId = 100; // avoid id collision with manual ids
const sessionStore = {};
const localStore = { maxParallel: 2 };
let downloadListeners = [], storageListeners = [], connectListeners = [];

function fire(delta) { for (const fn of [...downloadListeners]) fn(delta); }

const sandbox = {
  chrome: {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    downloads: {
      download: async (opts) => {
        const id = nextDownloadId++;
        downloads.set(id, { id, url: opts.url, state: 'in_progress', bytesReceived: 0, totalBytes: 512 });
        console.log('  [download called for', opts.url, '-> id', id + ']');
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
  setInterval: () => 1,
  clearInterval: () => {},
};

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
  vm.runInContext(fs.readFileSync('/tmp/hbd-test/background-instr.js', 'utf8'), vm.createContext(sandbox));
  await new Promise(r => setTimeout(r, 150));
  console.log('final downloads:');
  for (const d of downloads.values()) console.log('  ', d.id, d.url, d.state);
})();
