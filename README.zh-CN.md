<div align="center">
  <img src="src/web/assets/icon.png" alt="Wikinest Logo" width="128" />
  <h1>Wikinest</h1>
  <p><strong>你的笔记应该随着时间越来越有价值，而不是越来越难用。</strong></p>
  <p>一个本地优先的个人知识收件箱，把随手记录变成整洁、可调用的 Markdown。</p>
  <p>
    <a href="./README.md">English</a> · <strong>简体中文</strong>
  </p>
  <p>
    <a href="https://github.com/qingkongzhiqian/wikinest/releases"><img alt="Release" src="https://img.shields.io/github/v/release/qingkongzhiqian/wikinest?include_prereleases&label=download&color=0a84ff"></a>
    <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey">
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen">
    <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  </p>
</div>

---

## 你明明保存了，后来却再也找不到

周一，你和 Cursor 讨论出了一个很重要的结论。

周二，你从一篇文章里复制了一段很有启发的文字。周三，你随手写下一个产品想法。到了周五，这些内容已经散落在聊天记录、临时文档、浏览器标签页和一堆 Markdown 文件里。

你告诉自己：以后有时间再整理。

但那个“以后”很少到来。

笔记越来越多，排版越来越乱，原来设计的文件夹和分类逐渐失效。几个月后，你甚至不记得自己写过什么；搜索时只要想不起当初使用的关键词，就像从未记录过一样。

原本为了帮助自己记忆而建立的知识库，慢慢变成了一个不愿打开的地方。

问题从来不是“怎么记下来”。

**真正困难的是记录之后的排版、归类、维护，以及在未来重新找到它。**

## Wikinest 接管记录之后的工作

Wikinest 是一个本地优先的个人知识收件箱。

粗糙的想法、复制的文字、会议记录、研究片段，甚至一段值得保存的 AI 对话，都可以直接丢进来。Wikinest 会把它们整理成规范的 Markdown，归入可复用的分类，并让这些知识持续对你和你的 AI 工具可用。

你只负责记录，Wikinest 负责维护。

等到需要时，你可以按关键词搜索、按语义寻找、直接向知识库提问，也可以让 Cursor 和 Claude 通过 MCP 调用过去沉淀的内容。

```text
随手记录任何内容
        ↓
AI 自动排版和归类
        ↓
Markdown 知识库持续保持整洁
        ↓
未来的人和 AI 都能重新调用
```

## 一个不会随着时间腐烂的知识库

### 记录之前，不需要先整理

你可以直接在编辑器里写，粘贴一大段文字，通过命令行导入，或者让 AI 助手把当前对话存进知识库。

不必先决定放在哪个文件夹，不必想标签，也不必把内容收拾得像一篇完整文章之后才配保存。

### 把维护工作交给 AI

Wikinest 可以：

- 整理标题层级、段落、列表、代码块和标点；
- 自动归类，并优先复用已有分类；
- 根据内容生成更合适的标题；
- 把散落的相关笔记聚合成一篇完整综述。

AI 给出的结果只是起点，不是限制。标题、分类和正文始终由你掌控，随时可以修改。

### 忘记关键词，也能重新找到

记得原话时，用全文搜索；只记得大概意思时，用语义搜索；想直接得到结论时，就向 Wikinest 提问。

回答会附带来源，并能跳回原始笔记。即使知识库已经大到超出你的记忆范围，它仍然可以被使用，而不只是被保存。

## 为 AI 时代而生，但知识始终属于你

AI 很擅长帮助你完成当前这次对话，却不擅长把你的知识带到下一次对话。

Wikinest 为它们补上一个长期记忆层：

- Cursor 和 Claude 可以通过 MCP 写入笔记；
- 它们可以读取和搜索你过去保存的内容；
- 回答以原始笔记为依据，而不是凭空猜测；
- 有价值的结论不会随着聊天窗口关闭而消失。

但你的知识并没有因此被锁进某个 AI 平台。所有笔记仍然是你所选择文件夹里的普通 `.md` 文件。

你可以用其他编辑器打开、自己备份、同步到其他设备，或者直接交给 Git 管理。

## 你会得到什么

- **本地优先的 Markdown** —— 笔记始终是你拥有的文件。
- **Vault 切换** —— 任意文件夹都能作为知识库，并可快速切换最近打开的 Vault。
- **AI 自动排版** —— 把随手粘贴的内容整理成可读 Markdown，不改变原意。
- **自动分类** —— 使用可复用的 frontmatter 分类维护笔记。
- **全文与语义搜索** —— 既能按原话找，也能按意思找。
- **问知识库** —— 基于笔记回答问题，并附带原文来源。
- **AI 聚合** —— 把某个分类或手动选择的笔记整理成一篇完整文章。
- **内置 MCP** —— 直接连接 Cursor、Claude Code 和其他 MCP 客户端。
- **图片上传** —— 粘贴或拖拽图片到任意 S3 兼容存储。
- **中英文界面** —— 在设置中即时切换 English / 简体中文。
- **桌面、Web、Docker 与 CLI** —— 同一个知识库，多种使用方式。

> 即使没有 API Key，Wikinest 仍然是一个快速、本地、纯 Markdown 的个人知识库。配置兼容模型后，AI 功能会自动启用。

## 从桌面版开始

前往 [GitHub Releases](https://github.com/qingkongzhiqian/wikinest/releases) 下载最新版本。

| 平台 | 安装包 |
| --- | --- |
| macOS — Apple 芯片和 Intel | `.dmg` |
| Windows | `.exe` 安装程序 |
| Linux | `.AppImage` / `.deb` |

首次启动时，选择一个文件夹作为 Vault。Wikinest 会记住它，之后可以通过 **文件 → 打开文件夹…** 或 **打开最近** 随时切换。

界面语言、大模型、Embedding、图片存储和本地 MCP 连接方式都可以在 **设置** 中管理。

### 从源码运行

需要 Node.js 18 或更高版本：

```bash
git clone https://github.com/qingkongzhiqian/wikinest.git
cd wikinest
npm install
npm run desktop
```

## 连接 Cursor 或 Claude Code

桌面 App 会启动一个稳定的本地 MCP 地址：

```text
http://127.0.0.1:4321/mcp
```

点击 Wikinest 左下角的 **MCP 运行中**，即可复制当前地址，以及 Cursor 和 Claude Code 可以直接使用的配置。

连接后，你可以让 AI 助手：

- 把当前结论保存到知识库；
- 创建或更新笔记；
- 搜索以前记录过的内容；
- 整理现有笔记；
- 聚合某个分类；
- 根据整个知识库回答问题。

可用工具包括 `save_conversation`、`write_note`、`read_note`、`list_notes`、`search_notes`、`tidy_note`、`synthesize_category` 和 `ask_wiki`。

## 配置 AI 功能

Wikinest 支持 OpenAI 兼容接口，包括 OpenAI、DeepSeek、通义千问和自托管模型。

桌面版可以直接在 **设置** 中填写。CLI、Docker 或 Web 部署可以使用环境变量：

```bash
LLM_BASE_URL=https://api.example.com/v1
LLM_API_KEY=你的-api-key
LLM_MODEL=你的模型
```

Embedding 用于语义搜索和知识库问答。它会在兼容时复用 LLM 配置，也可以通过 `EMBED_*` 单独设置。

图片上传支持 AWS S3、Cloudflare R2、阿里云 OSS、MinIO 和其他 S3 兼容服务。完整配置见 [`.env.example`](./.env.example)。

## 自托管

通过 Docker 运行 Web 与 MCP 服务：

```bash
cp .env.example .env
docker compose up -d --build
```

笔记会保存在宿主机的 `./content` 中，项目附带的 Compose 配置使用 Caddy 提供 HTTPS。

暴露到公网前，请务必配置：

- `WIKI_PASSWORD`：保护 Web 页面；
- `WIKI_TOKEN`：保护 MCP 接口。

服务默认不启用认证，缺少配置时会在启动日志中明确警告。

## 命令行

```bash
echo "# 今天" | wiki add journal/2026-07-14
wiki search "产品定位"
wiki tidy journal/2026-07-14
wiki digest "机器学习"
```

## 开发

```bash
npm install
npm test
npm run desktop
```

构建安装包：

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

## 许可证

社区核心依据 [GNU AGPLv3](./LICENSE) 开源。需要在不承担 AGPL 义务的情况下分发、嵌入或运营 Wikinest 的组织，可以申请单独的商业许可。

官方商业版未来可能包含不属于本社区仓库的闭源付费功能。详细说明请参阅 [LICENSING.zh-CN.md](./LICENSING.zh-CN.md)。

版权所有 © 2026 Wise Future Innovations Limited。

---

<p align="center">
  <strong>放心记录，留下价值。</strong>
</p>
