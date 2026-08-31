// Test harness for humble-bundle-downloader/background.js
// Stubs the chrome.* APIs and drives the service worker through
// parallel-queue scenarios, including simulated service-worker restarts.

const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const BG = '../background.js';

// --- shared "browser" state (survives simulated SW restarts) ---
const downloads = new Map();
let nextDownloadId = 1000; // avoid colliding with ids the tests create by hand
const sessionStore = {};
const localStore = {};

// --- per-worker registrations (reset on each simulated restart) ---
let downloadListeners = [];
let storageListeners = [];
let connectListeners = [];
let timers = new Set();

function fireDownloadEvent(delta) {
  for (const fn of [...downloadListeners]) fn(delta);
}

function makeChrome() {
  return {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    downloads: {
      download: async (opts) => {
        const id = nextDownloadId++;
        downloads.set(id, {
          id, url: opts.url, filename: opts.filename,
          state: 'in_progress', bytesReceived: 0, totalBytes: 512,
        });
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
      // Real chrome.downloads.cancel is async: the onChanged event fires
      // after the current synchronous work has finished.
      cancel: (id) => Promise.resolve().then(() => {
        const d = downloads.get(id);
        if (!d || d.state !== 'in_progress') return;
        d.state = 'interrupted';
        fireDownloadEvent({
          id,
          state: { previous: 'in_progress', current: 'interrupted' },
          interrupt: { current: 'canceled' },
        });
      }),
      onChanged: { addListener: (fn) => downloadListeners.push(fn) },
    },
    storage: {
      session: {
        set: async (o) => Object.assign(sessionStore, o),
        get: async (k) => ({ [k]: sessionStore[k] }),
      },
      local: {
        set: async (o) => {
          const changes = {};
          for (const [k, v] of Object.entries(o)) {
            changes[k] = { newValue: v };
            localStore[k] = v;
          }
          for (const fn of [...storageListeners]) fn(changes, 'local');
        },
        get: async (k) => ({ [k]: localStore[k] }),
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    runtime: { onConnect: { addListener: (fn) => connectListeners.push(fn) } },
  };
}

let rawLoadWorker = () => {
  // Simulate a service-worker (re)start: old timers/listeners are gone,
  // browser-level state (downloads, storage) survives.
  timers.clear();
  downloadListeners = [];
  storageListeners = [];
  connectListeners = [];
  const sandbox = {
    chrome: makeChrome(),
    console,
    setInterval: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearInterval: (t) => { if (t) timers.delete(t); },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BG, 'utf8'), ctx);
  return ctx;
};

async function loadWorker() {
  const ctx = rawLoadWorker();
  await settle(); // let loadSettings()/restoreState() finish
  return ctx;
}

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }

function makePort() {
  const port = {
    name: 'sidepanel',
    onMessage: { addListener: (fn) => { port.handle = fn; } },
    onDisconnect: { addListener: () => {} },
    messages: [],
    postMessage: (m) => port.messages.push(m),
  };
  connectListeners[0](port);
  return port;
}

function links(n) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Book ${String.fromCharCode(65 + i)}`,
    url: `https://cdn.humble.com/lib/book-${i}.pdf`,
  }));
}

function inFlightCount() {
  let n = 0;
  for (const d of downloads.values()) if (d.state === 'in_progress') n++;
  return n;
}

function complete(urlSubstr) {
  for (const d of downloads.values()) {
    if (d.state === 'in_progress' && d.url.includes(urlSubstr)) {
      d.state = 'complete';
      fireDownloadEvent({ id: d.id, state: { previous: 'in_progress', current: 'complete' } });
      return d.id;
    }
  }
  throw new Error('no in-flight download matching ' + urlSubstr);
}

function lastMsg(port) { return port.messages[port.messages.length - 1]; }
function activeTitles(port) { return lastMsg(port).active.map(a => a.title).sort(); }

let testNum = 0;
function pass(name) { console.log(`  ✓ Test ${++testNum} passed: ${name}`); }

(async () => {
  // ---- Test 1: default limit 4, queue refills, run completes ----
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]); Object.keys(localStore).forEach(k => delete localStore[k]);
  let ctx = await loadWorker();
  let port = makePort();
  await settle();
  assert.strictEqual(lastMsg(port).status, 'idle');

  port.handle({ action: 'startQueue', links: links(6) });
  await settle();
  let m = lastMsg(port);
  assert.strictEqual(inFlightCount(), 4, 'starts 4 of 6 by default');
  assert.strictEqual(m.status, 'downloading');
  assert.strictEqual(m.total, 6);
  assert.strictEqual(m.done, 0);
  assert.strictEqual(m.active.length, 4);
  assert.ok(m.active.every(a => a.url && a.title && 'bytesReceived' in a));

  complete('book-0');
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.done, 1);
  assert.strictEqual(JSON.stringify(m.completed), JSON.stringify(['Book A']));
  assert.strictEqual(m.active.length, 4, 'freed slot refilled');
  assert.ok(m.active.some(a => a.url.includes('book-4')), 'fifth file started');

  complete('book-1');
  await settle();
  for (const u of ['book-2', 'book-3', 'book-4', 'book-5']) { complete(u); await settle(); }
  m = lastMsg(port);
  assert.strictEqual(m.status, 'done');
  assert.strictEqual(m.done, 6);
  assert.strictEqual(m.active.length, 0);
  assert.strictEqual(m.completed.length, 6);
  pass('default limit of 4, slots refill as files finish, run completes');

  // ---- Test 2: limit change mid-run applies immediately ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  assert.strictEqual(lastMsg(port).status, 'idle');

  port.handle({ action: 'startQueue', links: links(8) });
  await settle();
  assert.strictEqual(inFlightCount(), 4);

  await ctx.chrome.storage.local.set({ maxParallel: 2 });
  await settle();
  // Lowering the limit doesn't kill in-flight downloads...
  assert.strictEqual(inFlightCount(), 4);
  // ...but throttles new starts: finish 2, no refill.
  complete('book-0'); complete('book-1');
  await settle();
  assert.strictEqual(inFlightCount(), 2, 'no refill after lowering limit to 2');

  await ctx.chrome.storage.local.set({ maxParallel: 6 });
  await settle();
  assert.strictEqual(inFlightCount(), 6, 'raising limit starts more queued downloads');
  for (const u of ['book-2', 'book-3', 'book-4', 'book-5', 'book-6', 'book-7']) { complete(u); await settle(); }
  assert.strictEqual(lastMsg(port).status, 'done');
  assert.strictEqual(lastMsg(port).done, 8);
  pass('mid-run limit changes (2 then 6) applied immediately via storage');

  // ---- Test 3: cancel stops everything, not counted as done ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  port.handle({ action: 'startQueue', links: links(6) });
  await settle();
  assert.strictEqual(inFlightCount(), 6);
  port.handle({ action: 'cancelQueue' });
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.status, 'cancelled');
  assert.strictEqual(m.done, 0, 'cancelled files are not counted as done');
  assert.strictEqual(inFlightCount(), 0);
  pass('cancel stops all in-flight downloads and clears the queue');

  // ---- Test 4: cancel racing a pending start ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  port.handle({ action: 'startQueue', links: links(6) });
  port.handle({ action: 'cancelQueue' }); // before any download starts
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.status, 'cancelled');
  assert.strictEqual(m.done, 0);
  assert.strictEqual(inFlightCount(), 0, 'pending starts were cancelled too');
  pass('cancel during pending download starts does not resurrect downloads');

  // ---- Test 5: SW restart mid-run (one finished while asleep) ----
  localStore.maxParallel = 2;
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  ctx = await loadWorker();
  port = makePort();
  await settle();
  port.handle({ action: 'startQueue', links: links(6) });
  await settle();
  assert.strictEqual(inFlightCount(), 2, 'limit 2 loaded from storage');

  // "Book A" completes while the worker is asleep (no event seen).
  for (const d of downloads.values()) {
    if (d.state === 'in_progress' && d.url.includes('book-0')) d.state = 'complete';
  }
  ctx = await loadWorker(); // simulate Chrome restarting the worker
  port = makePort();
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.status, 'downloading', 'run resumed');
  assert.strictEqual(m.done, 1, 'completion while asleep was reconciled');
  assert.ok(m.completed.includes('Book A'));
  assert.strictEqual(inFlightCount(), 2, 'still throttled to 2 (B kept, C started)');
  assert.strictEqual(JSON.stringify(activeTitles(port)), JSON.stringify(['Book B', 'Book C']));

  complete('book-1');
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.done, 2);
  assert.ok(m.active.some(a => a.url.includes('book-3')), 'next queued file started');
  pass('SW restart mid-run: reconciles finished downloads, resumes queue at the saved limit');

  // ---- Test 6: SW restart with an interrupted-while-asleep download ----
  for (const u of ['book-2', 'book-3', 'book-4', 'book-5']) { complete(u); await settle(); }
  assert.strictEqual(lastMsg(port).status, 'done');

  localStore.maxParallel = 1;
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  ctx = await loadWorker();
  port = makePort();
  await settle();
  port.handle({ action: 'startQueue', links: links(3) });
  await settle();
  assert.strictEqual(inFlightCount(), 1);
  for (const d of downloads.values()) {
    if (d.state === 'in_progress' && d.url.includes('book-0')) d.state = 'interrupted';
  }
  ctx = await loadWorker();
  port = makePort();
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.done, 1, 'interrupted-while-asleep counted as handled');
  assert.strictEqual(inFlightCount(), 1, 'queue kept moving after the failure');
  complete('book-1'); await settle();
  complete('book-2'); await settle();
  m = lastMsg(port);
  assert.strictEqual(m.status, 'done');
  assert.strictEqual(m.done, 3);
  pass('SW restart with interrupted download: counted once, queue continues');

  // ---- Test 7: polling updates per-file byte counters ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  localStore.maxParallel = 2;
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  ctx = await loadWorker();
  port = makePort();
  await settle();
  port.handle({ action: 'startQueue', links: links(2) });
  await settle();
  for (const d of downloads.values()) {
    if (d.url.includes('book-0')) d.bytesReceived = 256;
  }
  for (const t of [...timers]) t.fn(); // fire the worker's poll interval
  await settle();
  m = lastMsg(port);
  const a0 = m.active.find(a => a.url.includes('book-0'));
  assert.strictEqual(a0.bytesReceived, 256, 'polling picked up byte progress');
  pass('progress polling reports per-file bytesReceived for each in-flight download');

  // ---- Test 8: setting clamping on load ----
  for (const u of ['book-0', 'book-1']) { complete(u); await settle(); }
  localStore.maxParallel = 99;
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  ctx = await loadWorker();
  port = makePort();
  await settle();
  port.handle({ action: 'startQueue', links: links(10) });
  await settle();
  assert.strictEqual(inFlightCount(), 8, 'limit clamped to max of 8');
  pass('out-of-range stored limit clamped (99 -> 8)');

  localStore.maxParallel = '0';
  downloads.clear(); Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  ctx = await loadWorker();
  port = makePort();
  await settle();
  port.handle({ action: 'startQueue', links: links(3) });
  await settle();
  assert.strictEqual(inFlightCount(), 1, 'limit clamped to min of 1');
  pass('out-of-range stored limit clamped (0 -> 1)');
  for (const u of ['book-0', 'book-1', 'book-2']) { complete(u); await settle(); }
  assert.strictEqual(lastMsg(port).status, 'done');

  // ---- Test 9: restart with a pending start that DID reach Chrome ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  downloads.clear();
  Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  localStore.maxParallel = 2;

  // Simulate the exact moment the worker died: A is registered in-flight
  // (id 1), B's download call reached Chrome (id 2, in_progress) but the
  // worker never recorded the id, C/D still queued.
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

  ctx = await loadWorker();
  port = makePort();
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.status, 'downloading', 'run resumed after pending-start restart');
  assert.strictEqual(inFlightCount(), 2, 'both A and adopted B active');
  assert.strictEqual(JSON.stringify(activeTitles(port)), JSON.stringify(['Book A', 'Book B']));
  const b = m.active.find(a => a.url.includes('book-1'));
  assert.strictEqual(b.bytesReceived, 50, 'adopted download kept its byte counters');
  complete('book-0');
  await settle();
  m = lastMsg(port);
  assert.strictEqual(m.done, 1);
  assert.ok(m.active.some(a => a.url.includes('book-2')), 'C started after A settled');
  pass('restart with pending start: download that reached Chrome is adopted, not redownloaded');

  // ---- Test 10: restart with a pending start that never reached Chrome ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  downloads.clear();
  Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  localStore.maxParallel = 2;
  downloads.set(1, { id: 1, url: 'https://cdn.humble.com/lib/book-0.pdf', state: 'in_progress', bytesReceived: 0, totalBytes: 512 });
  sessionStore.downloadQueueState = {
    queue: [
      { title: 'Book C', url: 'https://cdn.humble.com/lib/book-2.pdf' },
      { title: 'Book D', url: 'https://cdn.humble.com/lib/book-3.pdf' },
    ],
    inFlight: [[1, { title: 'Book A', url: 'https://cdn.humble.com/lib/book-0.pdf', bytesReceived: 0, totalBytes: 512 }]],
    starting: [{ title: 'Book B', url: 'https://cdn.humble.com/lib/book-1.pdf' }],
    allItems: links(4),
    progress: { done: 0, total: 4, status: 'downloading', completed: [] },
  };

  ctx = await loadWorker();
  port = makePort();
  await settle();
  m = lastMsg(port);
  assert.strictEqual(inFlightCount(), 2, 'A plus re-queued B active');
  assert.strictEqual(JSON.stringify(activeTitles(port)), JSON.stringify(['Book A', 'Book B']), 'B was re-queued and restarted');
  pass('restart with pending start: download that never started is re-queued');

  // ---- Test 12: startQueue racing worker startup uses the stored limit ----
  port.handle({ action: 'acknowledgeDone' });
  await settle();
  downloads.clear();
  Object.keys(sessionStore).forEach(k => delete sessionStore[k]);
  localStore.maxParallel = 1;
  ctx = rawLoadWorker(); // do NOT wait for startup to finish
  port = makePort();
  port.handle({ action: 'startQueue', links: links(4) }); // fires before ready
  await settle();
  assert.strictEqual(inFlightCount(), 1, 'stored limit applied despite startup race');
  for (const u of ['book-0', 'book-1', 'book-2', 'book-3']) { complete(u); await settle(); }
  assert.strictEqual(lastMsg(port).status, 'done');
  assert.strictEqual(lastMsg(port).done, 4);
  pass('startQueue during worker startup waits for settings/restore before starting');

  console.log(`\nAll ${testNum} tests passed.`);
  process.exit(0);
})().catch(err => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
