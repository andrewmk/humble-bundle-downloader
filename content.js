// Content script: scrapes comic/book download links from the Humble Bundle page

function getDownloadLinks() {
  const links = [];

  console.log("Scanning for links...");

  // Humble Bundle CDN links use the class "a" on anchor tags pointing to cdn.humble.com
  document.querySelectorAll('a.a[href*="cdn.humble.com"]').forEach(el => {
    const url = el.href;
    if (!url) return;

    // Derive a human-readable title by walking up the DOM tree
    const title =
      el.closest('[data-human-name]')?.getAttribute('data-human-name') ||
      el.closest('[data-title]')?.getAttribute('data-title') ||
      el.textContent.trim() ||
      decodeURIComponent(url.split('/').pop().split('?')[0]) ||
      'download';

    if (!links.find(l => l.url === url)) {
      console.log("Adding link " + url);
      links.push({ url, title: title.trim() });
    }
  });

  console.log("Returning links to caller...");
  return links;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getDownloadLinks') {
    console.log("Received message getDownloadLinks...");
    const links = getDownloadLinks();
    sendResponse({ links });
  }
  return true;
});

 console.log("Humble bundle content script loaded");