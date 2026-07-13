<h1 align="center">Wikinest</h1>

<p align="center">
  <b>Just dump your notes in — it formats and files them for you. However many you have, they stay tidy and findable.</b><br/>
  <b>笔记随手丢进来,排版和分类自动完成。再多,也依然理得清、找得到。</b>
</p>

<p align="center">
  <a href="https://github.com/qingkongzhiqian/wikinest/releases"><img alt="Release" src="https://img.shields.io/github/v/release/qingkongzhiqian/wikinest?include_prereleases&label=download&color=0a84ff"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-orange">
</p>

<p align="center">
  Local-first · Plain Markdown · AI auto-formatting & auto-categorizing · Fully customizable<br/>
  本地优先 · 纯 Markdown · AI 自动排版与分类 · 完全可自定义
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a>
</p>

<!--
  建议在此处放一张产品截图或 GIF,能极大提升开源项目的第一印象:
  <p align="center"><img src="docs/screenshot.png" alt="Wikinest screenshot" width="820"></p>
-->

---

## English

### The problem it actually solves

Taking notes is easy. **Keeping** them is not.

At first, a handful of Markdown files feels tidy. Then it grows. Formatting drifts — some notes are neat, others are a wall of pasted text. Nothing is categorized, or you spent an evening building a folder tree that no longer fits what you're actually saving. Six months in you have hundreds of notes, no idea what's in half of them, and search returns either everything or nothing. The archive you built to *remember* things has become the thing you *avoid*.

The real cost was never writing the notes — it was **maintaining** them. Formatting, categorizing, re-organizing, pruning: chores that pile up until you quietly give up, and your notes rot into a graveyard.

**Wikinest takes that maintenance off your hands.** Paste in raw, messy text — a half-formatted snippet, rough thoughts, a dumped conversation — and it:

- **tidies the formatting** into clean Markdown (fixes headings, lists, code blocks, punctuation) *without changing what you actually wrote*, and
- **files it under the right categories automatically**, reusing your existing ones instead of inventing new folders every time.

No folder tree to design. No tags to remember. You just throw things in. And whenever the automatic choice isn't what you want — the category, the title, the wording — **all of it is yours to override.**

### Features

- 📝 **Plain Markdown, local-first** — every note is a `.md` file in a folder you own; no database, no lock-in.
- 🤖 **AI auto-formatting** — turns messy pasted text into clean Markdown without changing your words.
- 🗂️ **AI auto-categorizing** — files each note under the right category (stored in frontmatter, not folders), reusing your existing ones.
- 🔍 **Full-text + semantic search** — find by keyword, or by meaning when you don't remember the words.
- 💬 **Ask your wiki (RAG)** — get answers with citations that jump back to the source note.
- 📰 **Category synthesis** — merge scattered notes in one category into a single coherent article.
- 🔌 **MCP built in** — let Cursor / Claude read and write your wiki directly.
- 🖼️ **Image upload** — paste/drag images, stored in any S3-compatible bucket.
- 🧩 **Runs anywhere** — desktop app, self-hosted web server, Docker, or CLI — same core.
- 🎛️ **Everything customizable** — every automatic choice is a starting point you can override.

> No API key? Wikinest is still a fast, local, plain-Markdown wiki. The auto-formatting and auto-categorizing simply switch on the moment you add one.

### How it works: dump → organize → recall

- **Dump — with zero friction.** Paste into the editor, pipe from the command line, or let an AI chat write straight in via [MCP](https://modelcontextprotocol.io). No formatting or filing required up front.
- **Organize — automatically, but never rigidly.** AI cleans up the formatting and auto-classifies each note (categories live in the file's frontmatter, not in folders). Reuse, rename, or merge categories, re-run classification, or just edit by hand — it's all customizable. It can even synthesize the scattered notes in one category into a single coherent article.
- **Recall — even when there's a lot.** Full-text search for when you remember the words; semantic search + "ask your wiki" (RAG) for when you don't. Answers come with citations that jump straight back to the source note, so a big pile stays as searchable as a small one.

### Your data, your rules

- **Local-first:** notes are just `.md` files (with optional YAML frontmatter) in a folder you control — open, edit, back up, or git them with any tool.
- **No lock-in:** categories, sources and metadata live inside the files themselves.
- **Everything is customizable:** auto-format and auto-classify are the default, not a cage. Rename/merge/remove categories, fix a title, or rewrite a note — the AI just gives you a good starting point.

### Download

Grab the latest desktop app from the **[Releases](https://github.com/qingkongzhiqian/wikinest/releases)** page:

| Platform | File |
|----------|------|
| macOS (Apple Silicon & Intel) | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.AppImage` / `.deb` |

> **First launch note (unsigned build).** Wikinest ships unsigned to stay free, so your OS may warn about an "unidentified developer".
> - **macOS:** right-click the app → **Open**, or run `xattr -cr /Applications/Wikinest.app` once.
> - **Windows:** on the SmartScreen prompt click **More info → Run anyway**.

On first launch you pick a folder as your Vault; it's remembered afterwards. Open or switch Vaults anytime from **File → Open Folder…** / **Open Recent**. AI and image-upload settings live in the in-app **Settings** (menu, or `Cmd/Ctrl+,`).

### Run from source (Desktop)

Requires **Node.js ≥ 18**. Your notes stay in a local folder you pick (your "Vault"), exactly like Obsidian.

```bash
git clone https://github.com/qingkongzhiqian/wikinest.git
cd wikinest
npm install
npm run desktop
```

### Self-host (web + MCP server)

Run it on a server so any device (or a remote Cursor / Claude) can read and write to it, with automatic HTTPS via Caddy:

```bash
cp .env.example .env      # set WIKI_DOMAIN / WIKI_TOKEN / WIKI_PASSWORD / LLM_* / S3_*
docker compose up -d --build
```

Notes persist on the host at `./content`. Prefer bare metal? See `deploy/wikinest.service` (systemd) or `deploy/ecosystem.config.cjs` (PM2).

### Turn on auto-formatting & auto-categorizing

Any OpenAI-compatible endpoint works (OpenAI / DeepSeek / Qwen / self-hosted) — switch providers by changing env vars (or in-app Settings for the desktop app), never code:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
```

Embeddings (for semantic search / ask) reuse the same config by default; override with `EMBED_*` if your provider has no embeddings endpoint. See `.env.example` for the full, commented list, including S3-compatible image storage.

### Capture from AI chats too (MCP)

Beyond pasting and the CLI, you can let Cursor / Claude write into your wiki directly — just say *"save this to my wiki"* at the end of a chat.

```json
{
  "mcpServers": {
    "wikinest": {
      "command": "node",
      "args": ["/path/to/wikinest/bin/wiki.js", "mcp"]
    }
  }
}
```

Self-hosted? Point it at your server instead:

```json
{
  "mcpServers": {
    "wikinest": {
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_WIKI_TOKEN" }
    }
  }
}
```

Tools: `save_conversation`, `write_note`, `read_note`, `list_notes`, `search_notes`, `tidy_note`, `synthesize_category`, `ask_wiki`.

### CLI

```bash
echo "# Today" | wiki add journal/2026-07-06   # from stdin
wiki search "keyword"                            # full-text search
wiki tidy journal/2026-07-06                     # AI-clean the formatting
wiki digest "Machine Learning"                   # synthesize a whole category
```

### Exposing it publicly?

The server is **open by default**. Before putting it on the internet, set `WIKI_TOKEN` (MCP Bearer) and `WIKI_PASSWORD` (web login) — startup logs warn loudly if either is missing. All paths are sandboxed to your content directory (`../` escapes are rejected), and rendered Markdown strips raw HTML so note content can't smuggle in scripts.

### Build installers yourself

```bash
npm run dist:mac      # .dmg   (macOS)
npm run dist:win      # .exe   (Windows)
npm run dist:linux    # .AppImage / .deb (Linux)
```

Output lands in `dist/`. Cross-building for other platforms is easiest via CI (e.g. GitHub Actions with macOS / Windows / Linux runners).

### Contributing

Contributions are welcome! Please open an issue to discuss substantial changes first, then fork and send a PR.

```bash
npm install
npm test          # run the test suite
npm run desktop   # try your changes
```

### License

[MIT](./LICENSE) © WiseFuturus

---

## 中文

### 它真正解决的问题

记笔记很容易,**维护**笔记才难。

一开始几篇 Markdown,看着挺整齐。然后越攒越多。排版开始参差不齐——有的干净,有的就是一坨粘贴进来的文本。要么根本没分类,要么你花一晚上搭的文件夹树早就装不下你真正在存的东西。半年后,几百篇笔记,一半你都想不起里面写了啥;一搜,不是全部命中就是啥也搜不到。这个你为了「记住」而建的库,变成了你「不想打开」的地方。

真正的成本从来不是写笔记,而是**维护**它们:排版、归类、重新整理、清理……这些杂活越堆越高,直到你悄悄放弃,笔记烂成一片墓地。

**Wikinest 把这些维护活儿从你手里接走。** 把原始的、乱的文本随手丢进来——半成品片段、粗糙的想法、一段导出的对话——它会:

- **自动排版**成规范的 Markdown(修正标题层级、列表、代码块、标点),但**不改动你写的内容**;
- **自动归类**到合适的分类下,并优先复用你已有的分类,而不是每次都新建一堆文件夹。

不用设计文件夹树,不用记标签,你只管丢进去。而当自动的结果不合你意——分类也好、标题也好、措辞也好——**这一切都能由你自己改。**

### 功能一览

- 📝 **纯 Markdown、本地优先** —— 每篇笔记都是你自己文件夹里的 `.md` 文件,无数据库,不绑定平台。
- 🤖 **AI 自动排版** —— 把粘贴进来的乱文本整理成规范 Markdown,不改动你写的内容。
- 🗂️ **AI 自动分类** —— 自动归类到合适的分类(存在 frontmatter,而非文件夹),并优先复用已有分类。
- 🔍 **全文 + 语义搜索** —— 记得关键词就全文搜;记不清就按语义搜。
- 💬 **问知识库(RAG)** —— 回答带出处角标,一点跳回原文。
- 📰 **分类综述** —— 把某个分类下零散的笔记聚合成一篇连贯文章。
- 🔌 **内置 MCP** —— 让 Cursor / Claude 直接读写你的 wiki。
- 🖼️ **图片上传** —— 粘贴 / 拖拽图片,存到任意 S3 兼容存储。
- 🧩 **到处都能跑** —— 桌面 App、自托管 Web、Docker、命令行,共用同一套内核。
- 🎛️ **一切可自定义** —— 每个自动结果都只是起点,随你修改。

> 没有 API key?Wikinest 依然是一个快速、本地、纯 Markdown 的知识库。填上 key,自动排版和自动分类立刻点亮。

### 它怎么运转:随手丢 → 自动整理 → 随时调用

- **随手丢——零摩擦。** 编辑器里粘贴、命令行管道、或让 AI 对话通过 [MCP](https://modelcontextprotocol.io) 直接写入。丢之前不用先排版、先归档。
- **自动整理——自动但不死板。** AI 帮你排版并自动分类(分类存在文件的 frontmatter 里,而不是靠文件夹)。分类可复用、可重命名、可合并,可以重跑归类,也可以纯手动改——全都能自定义。它甚至能把某个分类下零散的笔记聚合成一篇连贯的综述。
- **随时调用——笔记再多也不怕。** 记得关键词就全文搜索;记不清就用语义检索 + 「问知识库」(RAG)。回答都带出处角标,一点就跳回原文——库大到几百篇,也和几篇时一样好找。

### 你的数据,你说了算

- **本地优先:** 笔记就是文件夹里的 `.md` 文件(可带 YAML frontmatter),用任何工具都能打开、编辑、备份、纳入 git。
- **不绑定平台:** 分类、来源、元数据都存在文件本身里。
- **一切可自定义:** 自动排版和自动分类是默认,不是牢笼。重命名/合并/删除分类、改标题、重写正文——AI 只是给你一个好的起点。

### 下载

到 **[Releases](https://github.com/qingkongzhiqian/wikinest/releases)** 页面下载最新桌面 App:

| 平台 | 文件 |
|------|------|
| macOS(Apple 芯片 & Intel) | `.dmg` |
| Windows | `.exe` 安装包 |
| Linux | `.AppImage` / `.deb` |

> **首次打开提示(未签名版本)。** 为保持免费,Wikinest 未做代码签名,系统可能提示「来自身份不明的开发者」。
> - **macOS:** 右键点应用 → **打开**,或执行一次 `xattr -cr /Applications/Wikinest.app`。
> - **Windows:** 在 SmartScreen 弹窗点 **更多信息 → 仍要运行**。

首次启动选一个文件夹作为 Vault,之后自动记住。随时可在 **文件 → 打开文件夹… / 打开最近** 切换 Vault。AI 与图片上传配置都在应用内的 **设置**(菜单,或 `Cmd/Ctrl+,`)里填。

### 从源码运行(桌面版)

需要 **Node.js ≥ 18**。笔记保存在你自己选的本地文件夹(Vault)里,和 Obsidian 一样。

```bash
git clone https://github.com/qingkongzhiqian/wikinest.git
cd wikinest
npm install
npm run desktop
```

### 自托管(Web + MCP 服务)

部署到服务器,让任意设备(或远程的 Cursor / Claude)都能读写,并由 Caddy 自动签发 HTTPS:

```bash
cp .env.example .env      # 填 WIKI_DOMAIN / WIKI_TOKEN / WIKI_PASSWORD / LLM_* / S3_*
docker compose up -d --build
```

笔记持久化在宿主机 `./content`。想直接跑在物理机上?见 `deploy/wikinest.service`(systemd)或 `deploy/ecosystem.config.cjs`(PM2)。

### 开启自动排版与自动分类

任何 OpenAI 兼容接口都行(OpenAI / DeepSeek / 通义 / 自建)——换服务商只改环境变量(桌面版在应用内「设置」里填),不动代码:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
```

向量检索(语义搜索 / 问答)默认复用上面的配置;若你的服务商没有 embeddings 接口,用 `EMBED_*` 单独指定。完整带注释的配置(含 S3 兼容图片存储)见 `.env.example`。

### 也把 AI 对话收进来(MCP)

除了粘贴和命令行,你还能让 Cursor / Claude 直接往你的 wiki 里写——对话结尾说一句「把这段存进我的 wiki」即可。

```json
{
  "mcpServers": {
    "wikinest": {
      "command": "node",
      "args": ["/path/to/wikinest/bin/wiki.js", "mcp"]
    }
  }
}
```

自托管的话,改成指向你的服务器:

```json
{
  "mcpServers": {
    "wikinest": {
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer 你的-WIKI_TOKEN" }
    }
  }
}
```

工具:`save_conversation`、`write_note`、`read_note`、`list_notes`、`search_notes`、`tidy_note`、`synthesize_category`、`ask_wiki`。

### 命令行

```bash
echo "# 今天" | wiki add journal/2026-07-06   # 从 stdin 写入
wiki search "关键词"                             # 全文搜索
wiki tidy journal/2026-07-06                     # AI 整理排版
wiki digest "机器学习"                           # 把整个分类聚合成综述
```

### 要暴露到公网?

服务**默认无认证**。放到公网前,先设置 `WIKI_TOKEN`(MCP Bearer)和 `WIKI_PASSWORD`(Web 登录)——缺任一项启动时都会大声警告。所有路径都被限制在你的内容目录内(`../` 越狱会被拒绝);渲染 Markdown 时禁用原始 HTML,防止笔记内容夹带脚本。

### 自己打包安装程序

```bash
npm run dist:mac      # .dmg   (macOS)
npm run dist:win      # .exe   (Windows)
npm run dist:linux    # .AppImage / .deb (Linux)
```

产物输出到 `dist/`。跨平台交叉打包建议用 CI(例如 GitHub Actions 的 macOS / Windows / Linux runner)。

### 参与贡献

欢迎贡献!较大的改动请先开 issue 讨论,再 fork 并提交 PR。

```bash
npm install
npm test          # 运行测试
npm run desktop   # 试跑你的改动
```

### 许可证

[MIT](./LICENSE) © WiseFuturus

---

<p align="center">
  <sub>MIT License · Your notes, tidied and organized — without the busywork.</sub><br/>
  <sub>MIT 许可 · 你的笔记,自动排版归类,省下所有杂活。</sub>
</p>
