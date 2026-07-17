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

Write in the editor, paste a wall of text, use the CLI, or tell an AI assistant to save the current conversation through MCP.

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

Your knowledge is still stored as ordinary `.md` files in a folder you choose. There is no proprietary database and no platform lock-in. Open the files with another editor, back them up, sync them, or put them in Git.

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
- **English and Simplified Chinese UI** — switch languages from Settings.
- **Desktop, Web, Docker, and CLI** — one knowledge base, multiple ways to use it.

> No API key is required to use Wikinest as a fast local Markdown wiki. AI features appear when you configure a compatible model.

## Download the desktop app

The latest release is [Wikinest 1.0.1](https://github.com/qingkongzhiqian/wikinest/releases/tag/v1.0.1) for macOS. Choose the installer that matches your Mac:

| Mac | Download |
| --- | --- |
| Apple Silicon — M1, M2, M3, M4, or M5 | [Download DMG](https://github.com/qingkongzhiqian/wikinest/releases/download/v1.0.1/Wikinest-1.0.1-arm64.dmg) |
| Intel | [Download DMG](https://github.com/qingkongzhiqian/wikinest/releases/download/v1.0.1/Wikinest-1.0.1.dmg) |

Both installers are signed with the Developer ID of Wise Future Innovations Limited. This build is not notarized yet, so on first launch right-click the app and choose **Open** (or allow it under **System Settings → Privacy & Security**).

Open the downloaded DMG, drag Wikinest into **Applications**, and launch it. On first launch, choose a folder as your Vault. Wikinest remembers it and lets you switch Vaults later through **File → Open Folder…** or **Open Recent**.

Configure language, models, embeddings, image storage, and your local MCP connection from **Settings**.

### Run from source

Requires Node.js 18 or later:

```bash
git clone https://github.com/qingkongzhiqian/wikinest.git
cd wikinest
npm install
npm run desktop
```

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
