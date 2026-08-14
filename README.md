# Humble Bundle Sequential PDF Downloader

A Chrome extension that downloads PDFs from your Humble Bundle library one at a time, waiting for each to finish before starting the next.

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `humble-downloader` folder

## Usage

1. Open your Humble Bundle library/download page  
   (e.g. `https://www.humblebundle.com/downloads?key=YOURKEY`)
2. Click the extension icon in the Chrome toolbar
3. Click **Scan for PDF Links** — it will find all PDF download links on the page
4. Review the list, then click **Download All**
5. Each PDF downloads fully before the next one begins

## Notes

- Downloads go to your browser's default downloads folder
- If a PDF already exists, Chrome will append a number to avoid overwriting
- You can cancel mid-queue at any time
- The extension only activates on `humblebundle.com` pages
