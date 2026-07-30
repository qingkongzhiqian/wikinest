# Wikinest Web Capture

This directory is an unpacked Chrome/Edge Manifest V3 extension.

## Load locally

1. Start Wikinest Desktop. The extension connects to `http://127.0.0.1:4321`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `browser-extension` directory.

## Actions

- Click the toolbar icon to open the Wikinest side panel. The question box is
  immediately available; selecting page text optionally attaches it as context.
- The selection is tracked by a persistent content script, so it keeps working
  after reloads and across pages while the panel stays open.
- Use the gear button to configure an OpenAI-compatible Base URL, API key, and
  model specifically for the extension. The values stay in browser-local storage.
- Choose **仅收藏网址** in the panel when you only want the link.
- Select text and use **在 Wikinest 中处理选中内容** from the context menu.
- Ask any question about the selection, or use translation, summary, key-point,
  and explanation shortcuts. Selection context and AI chat history stay only in
  browser session storage and are cleared when the browser session ends; nothing
  is written to the Vault until you explicitly save a clip.

Bookmarks are stored under `bookmarks/`; confirmed web clips are stored under
`clips/`. Both remain ordinary Markdown files and participate in Vault sync.

Saving a URL never asks you to describe or file it: right after the capture is
written, Wikinest generates a one-line summary and a few reusable tags from the
page metadata and stores them in the frontmatter. Those labels drive the tag
filter in the 网址收藏 view and are embedded for semantic search, so a saved link
can be found by asking about it later. Bookmarks saved while no language model
is configured stay untouched — open one in the app and use **重新生成标签** once
a model is available.
