# Wikinest 统一 Markdown 编辑器设计

## 目标

将当前“渲染后的阅读页 + textarea 编辑页 + 可选预览”的双模式界面，替换为类似 Typora 的统一 Markdown 编辑器：

- 打开笔记后即可直接修改已渲染内容。
- Markdown 文件仍是唯一持久化真相源。
- 保留现有 Electron、Express、对象存储同步、MCP、RAG 和 AI 服务。
- 第一阶段只重构笔记编辑区域，不整体迁移导航、搜索、设置或桌面后端。
- 建立可复用的前端边界，为以后整体迁移 React 或 Tauri 做准备。

## 非目标

- 本阶段不迁移到 Tauri/Rust。
- 不重写 `src/core/*`、对象存储同步协议或 MCP 服务。
- 不整体重写索引、搜索、Ask、设置与同步界面。
- 不保证逐字符保存原始 Markdown 排版；允许语义等价的规范化。
- 不在首版加入数学公式、脚注或任意 HTML 块编辑。

## 技术选型

### 编辑器

使用 Milkdown/ProseMirror 构建 Markdown 优先的统一编辑器。

- ProseMirror 文档树负责交互、选区、撤销与组合输入。
- Milkdown parser/serializer 负责 Markdown 与文档树的转换。
- Markdown 字符串是 API、文件存储、同步和外部工具共享的数据格式。
- React 仅管理编辑器组件边界和周边状态，不把每次键入复制到 React state。

### 前端构建

新增 Vite + TypeScript + React 编辑器模块，作为现有页面中的独立应用岛。

首阶段保留 `src/web/page.js` 管理导航、索引、搜索、设置、同步和 AI 抽屉。编辑器岛只拥有：

- 当前 Markdown 文档；
- 编辑器 DOM 和 ProseMirror state；
- 保存状态；
- 编辑器选区；
- 图片、表格、代码块和 Mermaid 的节点交互。

禁止继续把新编辑器逻辑注入 `renderPage()` 的内联脚本。

## 模块边界

### `UnifiedMarkdownEditor`

职责：

- 加载 Markdown；
- 直接编辑渲染后的文档；
- 序列化 Markdown；
- 自动保存；
- 暴露稳定选区快照；
- 应用 AI 结果；
- 上传并插入图片；
- 显示保存与错误状态。

不负责：

- 笔记列表和路由；
- 对象存储同步；
- LLM 请求；
- 设置与 Vault 切换；
- 文件系统访问。

### `WikiClient`

编辑器只依赖一个 TypeScript 接口：

```ts
interface WikiClient {
  readNote(path: string, signal?: AbortSignal): Promise<NoteDocument>;
  saveNote(input: SaveNoteInput, signal?: AbortSignal): Promise<SaveNoteResult>;
  uploadImage(file: File, signal?: AbortSignal): Promise<UploadedAsset>;
}
```

首阶段实现 `HttpWikiClient`，继续调用现有 `/api/note` 与 `/api/upload`。

未来可以新增：

- `ElectronWikiClient`：通过 IPC 调用 Node Core；
- `TauriWikiClient`：通过 `invoke` 调用 Rust command。

编辑器组件不得直接调用 `fetch` 或 `window.wikiSettings`。

### 旧页面适配器

`page.js` 通过窄接口控制编辑器：

```ts
interface EditorHandle {
  load(document: NoteDocument): Promise<void>;
  flush(): Promise<void>;
  focus(): void;
  getSelectionSnapshot(): EditorSelectionSnapshot | null;
  applyAiResult(snapshot: EditorSelectionSnapshot, markdown: string, mode: 'replace' | 'insert'): boolean;
  destroy(): void;
}
```

页面导航在切换笔记、返回索引或关闭窗口前调用 `flush()`。

## 编辑体验

### 统一界面

- 打开已有笔记后立即显示可编辑的渲染文档。
- 删除“编辑”“预览”和分栏预览作为主要工作流。
- 保留显式“查看 Markdown 源码”回退入口，但首版不要求在源码模式中继续所见即所得。
- 新建笔记直接打开统一编辑器中的空文档。

### Markdown 行为

首版支持：

- 标题；
- 段落与硬换行；
- 有序和无序列表；
- 任务列表；
- 引用；
- 粗体、斜体、删除线和行内代码；
- 链接；
- 图片；
- 表格；
- fenced code block 与语言标记；
- Mermaid fenced block。

保存时允许：

- 列表标记规范化；
- 强调符号规范化；
- 空行和缩进规范化；
- 表格格式规范化。

不得丢失：

- 文本语义；
- 链接地址；
- 图片地址与替代文本；
- frontmatter；
- code fence 内容和语言；
- Mermaid 源码；
- 任务列表勾选状态。

### Mermaid

- 非激活状态显示渲染图。
- 光标进入 Mermaid 节点时显示源码编辑界面。
- 语法错误时保留源码并显示局部错误，不阻止整篇笔记保存。
- Mermaid 渲染不得执行任意脚本。

### 中文输入和撤销

- 必须正确处理 `compositionstart`、`compositionupdate`、`compositionend`。
- 组合输入期间不得自动保存中间拼音。
- 每次连续输入形成合理的撤销事务。
- AI 写回、图片插入和表格操作必须进入同一个撤销历史。

## 自动保存

### 时序

- 文档变化后等待 800ms 无新输入再保存。
- `Cmd/Ctrl+S` 取消当前 debounce 并立即保存。
- 切换笔记、返回索引、切换 Vault 和应用退出前执行 `flush()`。
- 同一文档任意时刻最多有一个网络保存请求。

### 版本与请求身份

每次加载获得文档基线标识。服务端使用当前 Markdown 文件完整字节的 SHA-256 十六进制摘要作为 `version`；摘要包含 frontmatter 与正文，不依赖文件时间戳。

保存请求包含：

```ts
interface SaveNoteInput {
  path: string;
  markdown: string;
  baseVersion: string;
}
```

响应包含新的 `version`。

规则：

- 保存完成时，只有请求对应的本地 revision 仍是当前 revision，才能显示“已保存”。
- 保存期间发生的新修改必须触发下一次保存。
- 旧请求返回不得覆盖较新的编辑器内容或保存状态。

### 保存状态

界面显示以下状态之一：

- `已保存`
- `正在保存…`
- `未保存`
- `保存失败，点击重试`
- `检测到外部修改`

失败时：

- 不清空本地编辑器；
- 不自动无限重试；
- 后续本地修改仍可重新触发保存；
- 用户可以手动重试。

## 外部修改与同步

### 无本地修改

收到对象同步或文件系统刷新事件时：

- 重新读取笔记；
- 比较版本；
- 版本变化则更新编辑器文档；
- 尽量保留当前滚动位置。

### 存在本地修改

不得使用远端或磁盘内容覆盖编辑器。

如果保存时 `baseVersion` 已过期：

- 服务端拒绝覆盖并返回稳定冲突错误；
- 本地内容继续留在编辑器；
- 使用现有冲突副本命名规则写入本地冲突副本；
- UI 告知用户原笔记已外部变化，并提供打开原笔记或冲突副本的入口。

不提供自动三方合并，不静默选择任一版本。

## AI 集成

### 上下文

AI 上下文直接来自 ProseMirror selection：

- 非空选区：默认只发送选区；
- 空选区：发送当前文档；
- “附带全文”仍是一次性的显式授权；
- 请求开始后冻结选区快照。

### 选区快照

```ts
interface EditorSelectionSnapshot {
  path: string;
  docRevision: number;
  from: number;
  to: number;
  selectedMarkdown: string;
}
```

AI 返回后，只有以下条件全部满足才能写回：

- 仍是同一笔记；
- 选区位置仍有效；
- 当前选区 Markdown 与快照一致；
- 相关范围没有被之后的编辑改变。

否则只允许复制结果。

### 写回

AI 完成结果支持：

- 替换选区；
- 插入到选区后；
- 复制。

写回作为一个 ProseMirror transaction：

- 可以一次撤销；
- 触发正常自动保存；
- 不绕过冲突和版本检查。

## 图片上传

- 选择或拖放图片后调用 `WikiClient.uploadImage()`。
- 上传完成后插入标准 Markdown image node。
- 上传期间显示占位节点。
- 失败后保留可重试占位，不插入损坏 URL。
- 剪贴板粘贴图片与文件选择使用同一管线。

## 旧实现迁移

### 受控回退

首阶段保留旧 textarea/阅读渲染代码，但默认不显示。

回退入口仅用于：

- 新编辑器无法解析文档；
- 特殊 Markdown 内容需要源码修复；
- 新编辑器初始化失败。

回退模式与统一编辑器不得同时写同一文档。进入回退前必须销毁编辑器实例并完成或取消其保存流程。

### 删除条件

满足以下条件后，后续任务可以删除旧双模式代码：

- 支持范围内的 Markdown 往返测试通过；
- 中文输入、撤销、自动保存和冲突测试稳定；
- 图片、表格、代码块、Mermaid 与 AI 写回完成验收；
- 至少保留一个版本周期的源码回退入口。

## 构建与运行

### 开发模式

- Vite 开发服务器提供编辑器 bundle 和 HMR。
- Express 继续提供 `/api/*`。
- Electron 开发启动等待 Express 和 Vite 都就绪。

### 生产模式

- Vite 输出静态资源到专用目录。
- Express 托管该目录或由现有页面加载已构建的编辑器 bundle。
- `electron-builder` 必须包含编辑器构建产物。
- 发布构建不得依赖运行时 Vite。

## 安全

- Milkdown 渲染结果不得执行 Markdown 中的脚本或事件属性。
- 链接协议仅允许安全白名单。
- 图片上传继续使用现有大小、类型和路径限制。
- 编辑器不得访问 LLM API Key、S3 Secret 或 Electron 主进程对象。
- AI 和保存错误不得包含 Vault 内容、凭证或上游原始响应。

## 测试策略

### 单元测试

- Markdown parser/serializer 往返；
- 保存状态机和请求 revision；
- debounce、立即保存和 flush；
- 版本冲突；
- AI selection snapshot 与写回保护；
- 图片占位状态；
- Mermaid 源码保留。

### 组件测试

- 直接编辑渲染内容；
- 中文组合输入期间不保存；
- 撤销和重做；
- 表格、任务列表、代码块和 Mermaid 节点；
- 保存状态与失败重试；
- AI 选区替换和陈旧选区禁用；
- 回退模式切换。

### API 与集成测试

- 带 `baseVersion` 的读取和保存；
- 过期版本拒绝与冲突副本；
- 图片上传；
- Electron 生产构建包含静态资源；
- 对象同步刷新不会覆盖未保存内容。

### 回归测试

现有 store、S3 同步、加密、MCP、AI SSE、安全错误和 Electron 生命周期测试必须继续通过。

## 验收标准

- 打开笔记后无需点击“编辑”即可修改。
- 用户看到的是渲染后的 Markdown，而不是常驻 textarea。
- 800ms 自动保存和 `Cmd/Ctrl+S` 均可靠。
- 中文输入法无重复字符、跳光标或中间拼音保存。
- 当前支持范围内的 Markdown 内容保存后语义不丢失。
- 本地未保存修改不会被同步或外部文件更新覆盖。
- AI 可直接使用统一编辑器选区并安全写回。
- 图片、表格、任务列表、代码块和 Mermaid 可编辑。
- 现有 Electron、对象同步、MCP、RAG 和 AI 后端无需重写。
- 全量测试与无签名 Electron 构建通过。
