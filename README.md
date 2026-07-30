<div align="center">
  <img src="src/web/assets/icon.png" alt="Wikinest logo" width="128" />
  <h1>Wikinest</h1>
  <p><strong>Your notes should become more valuable with time — not harder to use.</strong></p>
  <p>A local-first knowledge inbox that turns rough captures into organized, reusable Markdown.</p>
  <p>
    <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
  </p>
  <p>
    <a href="https://github.com/qingkongzhiqian/wikinest/releases"><img alt="Release" src="https://img.shields.io/github/v/release/qingkongzhiqian/wikinest?include_prereleases&label=download&color=0a84ff"></a>
    <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey">
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen">
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  </p>
</div>

<div align="center">
  <img src="docs/screenshots/all-notes.png" alt="Wikinest — rough captures tidied into clean Markdown and auto-filed into reusable categories" width="860" />
  <br /><br />
  <img src="docs/screenshots/article.png" alt="Wikinest — article view with rendered Markdown, code and Mermaid diagrams" width="860" />
</div>

---

## You saved it. Then you lost it.

On Monday, you reach an important conclusion in a conversation with Cursor.

On Tuesday, you copy a useful paragraph from an article. On Wednesday, you write down a rough product idea. By Friday, those fragments are scattered across chat histories, temporary documents, browser tabs, and a folder full of Markdown files.

You tell yourself you will organize them later.

Later rarely comes.

The notes keep growing. Formatting becomes inconsistent. Categories stop making sense. Search only works when you remember the exact words you used months ago. The knowledge base you created to help you remember slowly becomes another place you avoid opening.

The problem was never capturing information.

**The problem was everything that came after: cleaning, categorizing, maintaining, and finding it again.**

## Wikinest takes care of the after

Wikinest is a local-first personal knowledge inbox.

Drop in rough thoughts, copied text, meeting notes, research fragments, or useful AI conversations. Wikinest turns them into clean Markdown, files them into reusable categories, and keeps them available for both you and your AI tools.

You capture. Wikinest maintains.

And when you need something again, you can search by words, search by meaning, ask your knowledge base directly, or let Cursor and Claude access it through MCP.

```text
Capture anything
      ↓
AI tidies and categorizes it
      ↓
Your Markdown stays organized
      ↓
You and your AI can recall it later
```

## A knowledge base that does not rot

### Capture without preparing

Write in the editor, paste a wall of text, capture a bookmark or selection from
your browser, use the CLI, or tell an AI assistant to save the current
conversation through MCP.

No folder decision. No tag ritual. No need to make the note presentable before it deserves to exist.

### Let AI handle the maintenance

Wikinest can:

- clean headings, paragraphs, lists, code blocks, and punctuation;
- classify notes while reusing categories you already have;
- suggest useful titles;
- combine scattered notes into a coherent digest.

The AI provides a starting point, not a cage. Every title, category, and sentence remains editable.

### Find it even when you forgot the wording

Use full-text search when you remember the words. Use semantic search when you only remember the idea. Ask Wikinest a question and get an answer with links back to the source notes.

Your archive remains useful even after it grows beyond what you can remember.

## Built for the AI era, owned by you

AI tools are good at helping inside the current conversation. They are much worse at carrying your knowledge into the next one.

Wikinest gives them a durable memory layer:

- Cursor and Claude can write notes through MCP;
- they can search and read what you saved before;
- answers stay grounded in your original notes;
- useful conclusions stop disappearing with the chat window.

Your knowledge is still stored as ordinary `.md` files in a folder you choose. There is no proprietary database and no platform lock-in. Open the files with another editor, back them up, or use the desktop app's built-in Vault sync.

## What you get

- **Local-first Markdown** — your notes remain files you own.
- **Vault switching** — open any folder as a knowledge base and switch between recent Vaults.
- **AI formatting** — turn rough captures into readable Markdown without changing their meaning.
- **Automatic categorization** — organize notes with reusable frontmatter categories.
- **Full-text and semantic search** — recall by wording or by meaning.
- **Ask your knowledge base** — RAG answers with links to source notes.
- **AI synthesis** — turn notes from a category or selection into a coherent article.
- **Built-in MCP** — connect Cursor, Claude Code, and other MCP clients.
- **Image upload** — paste or drop images into any S3-compatible storage.
- **Encrypted Vault sync** — synchronize Markdown between desktop devices through S3-compatible object storage.
- **Unified Markdown editor** — edit rendered Markdown directly, with source fallback for unsupported or malformed documents.
- **Browser capture (beta)** — save bookmarks or review selected text in a Chrome/Edge side panel before writing it as Markdown.
- **English and Simplified Chinese UI** — switch languages from Settings.
- **Desktop, Web, Docker, and CLI** — one knowledge base, multiple ways to use it.

> No API key is required to use Wikinest as a fast local Markdown wiki. AI features appear when you configure a compatible model.

## Edit Markdown directly

The desktop app remains an Electron app. Open a note and edit its rendered Markdown immediately—there is no separate Edit/Preview workflow for supported content. The editor saves after 800 ms of inactivity; press `Cmd/Ctrl+S` to save immediately. It serializes the document back to Markdown, so equivalent list markers, emphasis delimiters, whitespace, indentation, and table layout may be normalized on save.

Supported editing includes GFM headings, lists and task items, links, tables, fenced code blocks, images, and Mermaid. Mermaid keeps its source available for editing, including when a diagram cannot render. Use **View Markdown source** when a document cannot be parsed, the editor fails to initialize, or specialized Markdown needs source-level repair.

Each save carries the version read with the note. If the file changed outside the current editor, Wikinest retains your draft rather than overwriting the other version and creates a conflict-copy Markdown file. Before switching notes or quitting, the app flushes pending saves.

AI is selection-first: with a non-empty editor selection, only that selection is sent by default. AI replacements and inserts are applied only when their captured selection is still current, remain undoable, and then follow the normal save and conflict checks.

## Capture from Chrome or Edge

The repository includes the open-source **Wikinest Web Capture** extension under
[`browser-extension/`](./browser-extension). It is currently distributed as an
unpacked beta:

1. Start Wikinest Desktop so the local service is available at `http://127.0.0.1:4321`.
2. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `browser-extension` directory.

Use the side panel to save the current URL, collect a selected passage, or review
AI translation, summary, key points, explanation, and question-answering output
before saving. Bookmarks and confirmed clips remain ordinary Markdown under
`bookmarks/` and `clips/`. Extension model credentials are optional and stay in
browser-local storage. See the [extension README](./browser-extension/README.md)
for shortcuts and details.

## Download the desktop app

The current linked release, [Wikinest 1.1.0](https://github.com/qingkongzhiqian/wikinest/releases/tag/v1.1.0), is for macOS. Choose the installer that matches your Mac:

| Mac | Download |
| --- | --- |
| Apple Silicon — M1, M2, M3, M4, or M5 | [Download DMG](https://github.com/qingkongzhiqian/wikinest/releases/download/v1.1.0/Wikinest-1.1.0-arm64.dmg) |
| Intel | [Download DMG](https://github.com/qingkongzhiqian/wikinest/releases/download/v1.1.0/Wikinest-1.1.0.dmg) |

Both installers are signed with the Developer ID of Wise Future Innovations Limited. This build is not notarized yet, so on first launch right-click the app and choose **Open** (or allow it under **System Settings → Privacy & Security**).

Windows and Linux are supported build targets; no Windows or Linux installer is linked as a published release here. You can build those targets yourself from source.

Open the downloaded DMG, drag Wikinest into **Applications**, and launch it. On first launch, choose a folder as your Vault. Wikinest remembers it and lets you switch Vaults later through **File → Open Folder…** or **Open Recent**.

Configure language, models, embeddings, image storage, Vault sync, and your local MCP connection from **Settings**.

### Run from source

Requires Node.js 18 or later:

```bash
git clone https://github.com/qingkongzhiqian/wikinest.git
cd wikinest
npm install
npm run desktop
```

## Sync a desktop Vault

The desktop app can synchronize a Vault in both directions through AWS S3, Cloudflare R2, Alibaba Cloud OSS, MinIO, or another S3-compatible object store. Vault sync is configured per Vault and is completely separate from image storage: image `S3_*` settings and image objects are not reused.

Only `.md` files are synchronized. Wikinest does not upload `.index/`, local settings or sync state, or image objects referenced by notes.

### Set up your devices

1. On the first device, open **Settings → Vault Sync**, select the provider, and enter its endpoint/region, bucket, prefix, access credentials, and an optional sync password.
2. Test the connection, then save and enable sync. Wait for this device's first successful sync before configuring another device.
3. On every later device, open the local Vault that should participate and configure exactly the same endpoint/region, bucket, prefix, and sync password.

Use a private bucket and credentials limited to the chosen prefix with only the permissions Wikinest needs: read, write, delete, and list. For AWS IAM this includes `s3:ListBucket` (used through `ListObjectsV2`) on the bucket as well as object permissions under the prefix. The connection test writes, reads, lists, and deletes a temporary probe. Desktop credentials are stored with the operating system's secure storage. Do not put Vault sync credentials in `.env`.

### Encryption and initialized prefixes

An empty sync password stores note paths and contents in plaintext in the bucket. **This is a significant privacy risk**, even with a private bucket. With a password, Wikinest derives a key using scrypt and encrypts both paths and contents with AES-256-GCM. The password is never recoverable; if every configured device forgets it, the remote data cannot be decrypted.

An empty prefix must be initialized by exactly one first device. Do not initialize it concurrently from multiple devices, especially with different passwords or plaintext/encrypted modes. Wait for the first successful sync before configuring later devices. This single-initializer rule is required by sync protocol v1 because S3-compatible stores do not provide a portable compare-and-swap operation for metadata.

The first device initializes the prefix as either plaintext or password-encrypted. That prefix's mode and password cannot be changed in place. To switch mode/password or migrate to another remote, configure a new, empty prefix on the first device only. Wikinest creates independent local sync state for the new remote identity and uploads the current local `.md` files as the new Vault's initial contents; it does not reference blobs from the old prefix. After that first sync succeeds, configure the remaining devices. The old prefix is retained and is never deleted automatically.

### Timing and behavior

- Sync runs when the Vault starts, every 60 seconds, about 2 seconds after a local write, and once more during exit with a maximum wait of 15 seconds.
- Offline and transient failures leave local notes intact and are retried by later sync runs.
- Concurrent edits are preserved as conflict-copy Markdown files rather than silently overwriting one version.
- Deletes and renames are synchronized. A rename is represented as a deletion plus a new path, so concurrent offline changes may produce a conflict copy.
- Sync protocol v1 uses an append-only remote operation log and does not garbage-collect old remote log objects.
- Run only one Wikinest instance per device for a given Vault. Each device must have a single writer for its local sync state.

Do not use Git, iCloud Drive, Dropbox, OneDrive, or another folder-sync tool on the same Vault while Vault sync is enabled. Two independent synchronizers can race and create duplicate, resurrected, or conflicting files. Normal editing is supported, and Wikinest checks for external changes before materializing remote content. However, POSIX/Node provides no portable atomic file compare-and-swap: a third-party write at the exact sync-materialization commit instant cannot receive a strong cross-process transactional guarantee. While sync is enabled, do not let another synchronizer or auto-save tool concurrently modify the same file.

## Connect Cursor or Claude Code

The desktop app exposes a stable local MCP endpoint:

```text
http://127.0.0.1:4321/mcp
```

Open the **MCP running** panel inside Wikinest to copy the current address and ready-to-use configuration for Cursor or Claude Code.

Once connected, you can ask your AI assistant to:

- save a conclusion to your wiki;
- create or update a note;
- search previous notes;
- tidy an existing note;
- synthesize a category;
- answer a question from your knowledge base.

Available tools include `save_conversation`, `write_note`, `read_note`, `list_notes`, `search_notes`, `tidy_note`, `synthesize_category`, and `ask_wiki`.

## Configure AI features

Wikinest works with OpenAI-compatible APIs, including OpenAI, DeepSeek, Qwen, and self-hosted providers.

Desktop users can configure these values in **Settings**. For CLI, Docker, or Web deployments:

```bash
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model
```

Embeddings power semantic search and knowledge-base Q&A. They reuse the LLM configuration when possible, or can be configured separately with `EMBED_*`.

### Use the AI assistant

When the assistant is collapsed, open it from the floating button centered on the right edge anywhere in Wikinest. It reuses your existing `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` configuration and supports multiple temporary threads.

On wide screens, the assistant opens as a content-pushing drawer instead of covering the page. Its width defaults to 380px and can be resized from 320px to 560px. On narrow screens, it opens as a dedicated assistant view so the conversation has the full viewport.

Context is selection-first:

- **Selection** — by default, Wikinest sends only the selection. Explicitly enable **Include full note** to also send the complete draft. This permission is momentary and resets when leaving the selection context. Selection responses can be copied, used to replace the captured selection, or inserted after it.
- **Document** — while reading a note, or editing without a selection, Wikinest sends the current note to help summarize, explain, or answer questions about it. Document responses can be copied but cannot be written back automatically.
- **General** — from the index or another view without document context, Wikinest does not send note content.

The configured model provider receives your instruction, eligible history from the current temporary thread, and only the context authorized for that request. Keep requests focused and do not send sensitive content unless you trust the provider and its data-handling policy.

Failures identify rate limiting (`429`), authentication or API-key problems, an unavailable or invalid model, network connectivity problems, and request timeouts. **Retry** is always a manual action and recaptures the selection, note authorization, and other current context at retry time instead of resending a stale snapshot.

Threads and drawer width exist only in memory. Threads disappear, and the width returns to its 380px default, when the page refreshes or the app exits. Neither is written to the Vault or synchronized through object storage.

Selection write-back is guarded: Wikinest applies a result only when the original selection and draft identity still match. If either changed while the model was responding, replace and insert are rejected so newer edits are not overwritten; copying remains available. AI output is never saved automatically—review the result and save the note yourself.

Image uploads support AWS S3, Cloudflare R2, Alibaba Cloud OSS, MinIO, and other S3-compatible services. See [`.env.example`](./.env.example) for all options.

## Self-host

Run Wikinest as a Web and MCP service with Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

Notes remain on the host in `./content`. Caddy provides HTTPS in the included Compose setup.

Before exposing the server publicly, configure:

- `WIKI_PASSWORD` for Web access;
- `WIKI_TOKEN` for MCP Bearer authentication.

The server is open by default and prints warnings when authentication is missing.

## CLI

```bash
echo "# Today" | wiki add journal/2026-07-14
wiki search "product positioning"
wiki tidy journal/2026-07-14
wiki digest "Machine Learning"
```

## Development

```bash
npm install
npm test
npm run desktop
```

Build installers:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## License

The community core is licensed under [GNU AGPLv3](./LICENSE). Organizations that need to distribute, embed, or operate Wikinest without AGPL obligations can obtain a separate commercial license.

Official commercial editions may include proprietary paid features that are not part of this community repository. See [LICENSING.md](./LICENSING.md) for details.

Copyright © 2026 Wise Future Innovations Limited.

---

<p align="center">
  <strong>Capture freely. Keep the value.</strong>
</p>
