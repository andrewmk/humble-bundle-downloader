// Runs in the page's MAIN world (see manifest: "world": "MAIN",
// "run_at": "document_start").
//
// The new Humble library pages trigger each download by calling
// window.open(signedUrl, "_blank", "noopener,noreferrer"). Extension content
// scripts run in an isolated world and cannot override the page's
// window.open, so this tiny script (same world as the page) wraps it.
//
// The wrapper only acts while the isolated-world content script is armed:
// that script sets document.documentElement.dataset.hbdCapture to a random
// one-time token (the DOM is shared between worlds), clicks the file's
// button, and then polls the DOM for the captured URL. At all other times
// calls pass straight through to the real window.open.

(() => {
  if (window.__hbdOpenHooked) return;
  window.__hbdOpenHooked = true;

  const origOpen = window.open;
  window.open = function (url, name, features) {
    const root = document.documentElement;
    const token = root ? root.dataset.hbdCapture : null;
    if (token && token !== "off") {
      // Hand the URL back to the isolated world over the shared DOM, tagged
      // with the one-time token so it matches the capture in flight.
      root.dataset.hbdCapturedUrl = String(url);
      root.dataset.hbdCapturedToken = token;
      // Swallow the call: the extension downloads this URL itself via
      // chrome.downloads, so no tab should open.
      return null;
    }
    return origOpen.call(window, url, name, features);
  };
})();
