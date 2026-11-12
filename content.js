// Content script: finds downloadable files on Humble Bundle library pages.
//
// Two page generations are supported:
//
// 1. Old pages: plain <a> links to cdn.humble.com rendered in the HTML —
//    scrape them directly.
//
// 2. New library pages (https://www.humblebundle.com/home/library/<uuid>, a
//    React app): there are no links at all. Each file is a button (one per
//    format: EPUB/PDF/MOBI...). Clicking a button makes the page fetch a
//    short-lived signed URL and call window.open(url). We reproduce the
//    click; page-hook.js (which runs in the page's MAIN world) swallows the
//    window.open call while we're armed with a one-time token, and records
//    the URL on the shared DOM — so chrome.downloads can fetch it without
//    any tab opening.

// --- old-style pages: direct links ------------------------------------------

function getLegacyLinks() {
  const links = [];
  document.querySelectorAll('a[href*="cdn.humble.com"]').forEach((el) => {
    const url = el.href;
    if (!url) return;

    const title =
      el.closest('[data-human-name]')?.getAttribute('data-human-name') ||
      el.closest('[data-title]')?.getAttribute('data-title') ||
      el.textContent.trim() ||
      decodeURIComponent(url.split('/').pop().split('?')[0]) ||
      'download';

    if (!links.find((l) => l.url === url)) {
      links.push({ url, title: title.trim() });
    }
  });
  return links;
}

// --- new-style pages: per-file download buttons ------------------------------

// One entry per downloadable file currently visible on the page:
// { uid, title (book), format (EPUB/PDF/...), size ("10.1 MB"), button }
function scanFileButtons() {
  const items = [];

  document.querySelectorAll('.bg-card').forEach((card) => {
    const bookTitle =
      card.querySelector('.text-base.truncate')?.textContent.trim() || '';

    // The "All N Items" card only offers a single combined (bulk) download;
    // we want the individual files instead.
    if (!bookTitle || /^all\s+\d+\s+items?$/i.test(bookTitle)) return;
    if (/bulk download/i.test(card.textContent)) return;

    card.querySelectorAll('button').forEach((btn, i) => {
      const format =
        btn.querySelector('span.truncate')?.textContent.trim().toUpperCase() || '';
      if (!format) return; // combobox / other buttons have no format label

      const sizeEl = [...btn.querySelectorAll('span')].find(
        (sp) => /^\(.*\)$/.test(sp.textContent.trim())
      );
      const size = sizeEl ? sizeEl.textContent.trim().replace(/[()]/g, '') : '';

      // uid is re-derivable from the DOM at any time (title + format +
      // position within the card), so it survives React re-renders.
      const uid = `${bookTitle}::${format}::${i}`;
      btn.dataset.hbdUid = uid;

      items.push({ uid, title: bookTitle, format, size, button: btn });
    });
  });

  return items;
}

// The page's click handler is async (it fetches signed URLs before calling
// window.open), so only one capture may be in flight at a time — otherwise
// we couldn't tell which window.open call belongs to which click.
let captureChain = Promise.resolve();
function withSingleCapture(fn) {
  const run = captureChain.then(fn);
  captureChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

const CAPTURE_TIMEOUT_MS = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureDownloadUrl(uid) {
  return withSingleCapture(async () => {
    const item = scanFileButtons().find((it) => it.uid === uid);
    if (!item) return { ok: false, error: 'button-not-found' };

    // The page disables a card's buttons while it's "preparing" a download
    // (and briefly right after, while React re-renders), so wait for the
    // button to be clickable instead of failing on a transient state.
    const enabledBy = Date.now() + 5000;
    while (item.button.disabled && Date.now() < enabledBy) await sleep(25);
    if (item.button.disabled) return { ok: false, error: 'button-disabled' };

    // Arm the MAIN-world window.open hook (page-hook.js) with a one-time
    // token, click this file's button, and wait for the hook to write the
    // signed URL back to the shared DOM. The DOM is the one thing both worlds
    // are guaranteed to share, so it's a more reliable hand-off than relying
    // on cross-world postMessage. The page's handler fetches the signed URL
    // (or uses its cache) and calls window.open(url); the hook swallows the
    // call and records the URL on document.documentElement's dataset.
    const root = document.documentElement;
    const token =
      'hbd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Clear any stale capture from a previous run before we arm.
    delete root.dataset.hbdCapturedUrl;
    delete root.dataset.hbdCapturedToken;
    root.dataset.hbdCapture = token;

    item.button.click();

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (root.dataset.hbdCapturedToken === token) {
          // Give the page a beat to re-enable the card's buttons (its
          // handler re-enables them right after window.open returns) so the
          // next serialized capture doesn't race the re-render.
          await sleep(100);
          return { ok: true, url: root.dataset.hbdCapturedUrl };
        }
        await sleep(25);
      }
      return { ok: false, error: 'timeout' };
    } finally {
      // Disarm and clean up so a later window.open (e.g. a link the user
      // clicks by hand) is never swallowed by mistake.
      if (root.dataset.hbdCapture === token) delete root.dataset.hbdCapture;
      delete root.dataset.hbdCapturedUrl;
      delete root.dataset.hbdCapturedToken;
    }
  });
}

// --- messaging ----------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getDownloadItems') {
    const legacy = getLegacyLinks();
    if (legacy.length > 0) {
      // Old-style page: we have real URLs up front, no clicking needed.
      const items = legacy.map((l) => ({
        uid: l.url,
        title: l.title,
        format: '',
        size: '',
        url: l.url,
      }));
      console.log(`Returning ${items.length} legacy links`);
      sendResponse({ items });
      return;
    }

    const items = scanFileButtons().map(({ button, ...rest }) => rest);
    console.log(`Returning ${items.length} download buttons`);
    sendResponse({ items });
  } else if (msg.action === 'getDownloadUrl') {
    captureDownloadUrl(msg.uid).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  return true;
});

console.log('Humble bundle content script loaded');
