# Personal Wiki

Markdown 个人知识库:文件按目录存 markdown,web 端查看/在线编辑,MCP 和 CLI 都能往里写文件。核心场景是每次和 AI 聊完,通过 MCP 把对话存进来。

## 结构

```
content/            # 你的笔记(md + 可选 frontmatter),支持任意子目录
src/
  core/store.js     # 核心:目录树 / 读写 / 搜索 / 路径安全
  core/storage.js   # 图片上传:S3 兼容对象存储
  render.js         # markdown → HTML
  web/              # Express web 服务(查看 + 在线编辑 + 图片上传)
  mcp/server.js     # MCP server
  cli.js            # 命令行
bin/wiki.js         # wiki 命令入口(启动时加载 .env)
```

笔记默认存在 `content/`,可用环境变量 `WIKI_CONTENT_DIR` 改到别处。

## 安装

```bash
npm install
npm link          # 可选:让 `wiki` 命令全局可用
```

## Web 服务

```bash
wiki serve                # 默认 http://localhost:4321
wiki serve --port 8080
```

左侧目录树 + 搜索,中间渲染视图,点「编辑」可在线改并保存(Cmd/Ctrl+S),「新建」支持子目录路径。

## 桌面 App(本地优先)

把 wiki 作为桌面应用运行,笔记全部保存在你选择的本地文件夹(Vault):

```bash
npm install
npm run desktop
```

首次启动会让你选择一个文件夹作为 Vault,之后自动记住。数据即该文件夹里的 `.md` 文件,可随时用其它工具打开或备份。

## CLI

```bash
echo "# 今天" | wiki add journal/2026-07-06   # 从 stdin 写入
wiki add chats/idea "# 灵感"                    # 直接给内容
wiki append journal/2026-07-06 "补充一段"       # 追加
wiki cat journal/2026-07-06                     # 打印原文
wiki ls                                         # 列出所有笔记
wiki search "关键词"                             # 全文搜索
wiki rm chats/idea                              # 删除
```

## MCP(核心场景)

MCP server 提供工具:`save_conversation`、`write_note`、`read_note`、`list_notes`、`search_notes`。支持两种连接方式:

### 本地 stdio(单机使用)

```bash
claude mcp add personal-wiki -- node /Users/yangning/Desktop/personal-wiki/bin/wiki.js mcp
```

或在 Claude Desktop 的 `claude_desktop_config.json` 里:

```json
{
  "mcpServers": {
    "personal-wiki": {
      "command": "node",
      "args": ["/Users/yangning/Desktop/personal-wiki/bin/wiki.js", "mcp"]
    }
  }
}
```

### 远程 HTTP(部署到服务器,多设备/Cursor 远程写入)

`wiki serve` 会在同一端口的 `POST /mcp` 上提供 Streamable HTTP 传输(无状态)。在 Cursor 的 `~/.cursor/mcp.json`(或 Claude Desktop)里填 URL + token:

```json
{
  "mcpServers": {
    "personal-wiki": {
      "url": "https://your-domain.com/mcp",
      "headers": { "Authorization": "Bearer 你的-WIKI_TOKEN" }
    }
  }
}
```

> ⚠️ 公网可写,**必须**设置 `WIKI_TOKEN`(见「部署与安全」)。未设置时 `/mcp` 对所有人开放写入。

之后对话里就能让 AI 「把这次对话保存到 wiki」,它会调用 `save_conversation`,自动写入带 `savedAt` / `title` / `tags` 的 markdown 文件。

## 部署与安全

服务默认**无认证**,直接暴露公网等于让任何人读写/删除你的笔记。部署前在 `.env` 里设置:

- `WIKI_TOKEN`:MCP (`/mcp`) 的 Bearer token,远程客户端用它连接。用 `openssl rand -hex 32` 生成。
- `WIKI_PASSWORD`(+ 可选 `WIKI_USER`,默认 `wiki`):Web UI / REST API 的 Basic Auth。

启动时会打印各项认证是否开启;未开启会有 `⚠️` 警告。

建议再前置一层反向代理提供 HTTPS(Caddy 最省事,自动签证书):

```caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:4321
}
```

并让 Node 只监听本机(配合 `WIKI_PORT`)、防火墙只放行 80/443。对象存储的 access key 建议用最小权限(仅指定桶/前缀的 `PutObject`)。

### 限流

`/mcp` 与 `/api/upload` 内置按 IP 的固定窗口限流(默认每分钟 120 / 30 次),超限返回 `429`。可用 `WIKI_MCP_RATE_LIMIT` / `WIKI_UPLOAD_RATE_LIMIT` 调整。有反向代理时设 `WIKI_TRUST_PROXY`(同机反代用默认 `loopback` 即可)让限流按真实客户端 IP 生效。

### 常驻运行

`deploy/` 提供两种守护进程配置,任选其一:

- **systemd**:`deploy/personal-wiki.service`(文件头有安装步骤)。
- **PM2**:`pm2 start deploy/ecosystem.config.cjs && pm2 save`。

两者都靠 `bin/wiki.js` 自动加载项目根 `.env`,无需重复配环境变量。

### Docker(推荐,含自动 HTTPS)

`docker-compose.yml` 会同时起 wiki 和 Caddy(自动签发 HTTPS 证书):

```bash
cp .env.example .env    # 填 WIKI_DOMAIN / WIKI_TOKEN / WIKI_PASSWORD / S3_* / LLM_*
docker compose up -d --build
```

笔记持久化在宿主机 `./content`。本地测试把 `WIKI_DOMAIN` 设为 `localhost` 即可。

## 自动分类

不用手动建文件夹分类。分类存在每篇笔记 frontmatter 的 `categories`(多值),由模型自动生成:

- **保存时自动归类**:在网页里写完保存,若该文没有分类且已配置模型,会自动打上 1~3 个分类(优先复用已有分类,避免类别爆炸)。
- **文章页管理分类**:点分类名可**重命名**(作用到所有文章),`✕` 从本文移除,`＋ 分类` 手动添加,`🤖 自动归类` 立即重跑。
- **首页按分类聚合**:顶部标签即分类,一篇多分类会出现在多个标签下;没分类的归到「未分类」。
- **批量归类**:`POST /api/classify/all`(默认只处理未分类的,传 `{"all":true}` 全部重跑)。

配置(OpenAI 兼容,换服务商只改环境变量):

```bash
# .env
LLM_BASE_URL=https://api.deepseek.com/v1   # 或 OpenAI / 通义 / 自建
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat                     # 或 gpt-4o-mini / qwen-plus ...
```

文件仍存在各自目录里(目录只是物理存放,不再是分类维度);「新建」只需填标题,自动放进 `notes/`。

## AI 整理(排版)

丢进来的原始文本(粘贴 / MCP),让模型整理成排版规范的 markdown:分段、补标题层级、列表、代码块、修正错别字标点。**只整理格式,不增删或改写事实**。

- **文章页**:点「🪄 整理」直接整理并保存(会覆盖当前正文,frontmatter 打上 `tidied: true`)。
- **编辑器**:点「🪄 AI 整理」把整理结果填回编辑框,确认后再保存(非破坏性)。
- **MCP**:`save_conversation` 传 `tidy: true` 即在保存前整理;`tidy_note` 工具整理已有笔记。
- **CLI**:`wiki tidy <path>`。
- **REST**:`POST /api/tidy {path}`(原地保存)、`POST /api/tidy/preview {content}`(只返回不保存)。

## AI 聚合成文(分类综述)

把同一分类下的所有零散笔记喂给模型,聚合、去重、按子主题重组,产出一篇连贯的综述文章。综述存到 `digests/<分类>.md`,标记 `digest: true`,**不参与分类计数、不出现在普通列表**。

综述**可回链到原始笔记**:正文里引用某篇内容处会带 `[[编号]]` 角标,文末自动生成「参考来源」列表,链接由代码确定性生成(不靠模型编 URL),点击即在应用内打开对应原文。来源路径也存进 frontmatter 的 `sources`。

- **网页**:进入某个分类标签,顶部出现「📚 AI 综述」卡片,点「✨ 生成综述」/「🔄 更新」;生成后点「查看综述」阅读。加了新笔记后再点更新即可保持最新。
- **MCP**:`synthesize_category` 工具。
- **CLI**:`wiki digest <分类>`。
- **REST**:`POST /api/digest {category}`。

整理和聚合都复用「自动分类」那套 LLM 配置(`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`),无需额外设置。长任务超时可用 `LLM_LONG_TIMEOUT_MS` 调整(默认 90s)。

## 问知识库(语义检索 + RAG 问答)

用大白话提问,系统对全部笔记做**向量语义检索**,把最相关的片段喂给模型,生成**带出处链接**的回答——即使你记不清原文用词也能翻出来。定位:记录→整理→**调用**的闭环。

- **网页**:左栏「问一问」进入问答页,输入问题(Enter 提交),回答里引用处带 `[[编号]]` 角标,文末「参考来源」可点击跳回原文。
- **MCP**:`ask_wiki` 工具(Cursor / Claude 里可直接问你的 wiki)。
- **REST**:`POST /api/ask {question}`;语义搜索 `GET /api/search/semantic?q=`;重建索引 `POST /api/reindex`;是否可用 `GET /api/rag/status`。

**配置**:embedding 默认复用上面的 `LLM_BASE_URL` / `LLM_API_KEY`(通义 DashScope 开箱即用,模型默认 `text-embedding-v3`)。若你的 LLM 服务商没有 embeddings 接口(如 DeepSeek),单独指定 `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` 即可(见 `.env.example`)。

**索引**:向量索引以 JSON 存在 `content/.index/`(隐藏目录,不算作笔记)。首次提问时自动构建,之后只对**新增/改动**的笔记增量重嵌入;删除的笔记自动清理。换 embedding 模型会自动全量重建。

## 图片存储(对象存储)

图片走 S3 兼容对象存储(AWS S3 / Cloudflare R2 / 阿里云 OSS / MinIO 通用),markdown 里只保存图片 URL,仓库保持纯文本轻量。

配置:复制 `.env.example` 为 `.env` 并填入你的桶信息(`.env` 已被忽略,不会提交):

```bash
cp .env.example .env
# 编辑 .env,至少填 S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
# 建议再填 S3_PUBLIC_BASE_URL(图片对外访问域名)
```

换服务商只改环境变量、不改代码。常见配置见 `.env.example` 内注释。

配好后 `wiki serve`,进入任意笔记点「编辑」,**粘贴**(Cmd/Ctrl+V)或**拖拽**图片进编辑框即可自动上传,并在光标处插入 `![](https://…)` 链接。未配置对象存储时上传会给出提示。

## 安全

所有路径都被限制在 `content/` 目录内,`../` 越狱会被拒绝。web 渲染禁用了原始 HTML,避免 AI 内容里夹带脚本。
