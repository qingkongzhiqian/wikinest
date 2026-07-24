import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTree, readNote, readNoteVersioned, writeNote, writeNoteVersioned, deleteNote, searchNotes, noteExists,
  CONTENT_DIR, getAllNotes, nextAvailablePath, moveNote, updateFrontmatter,
  normalizeCategoryList, setNoteCategories, listCategories, renameCategory, deleteCategory, noteVersion,
} from '../core/store.js';
import { classifyAndSet, autoTagIfEmpty, isClassifyConfigured } from '../core/classify.js';
import {
  tidyAndSet, tidyMarkdown, synthesizeCategory, synthesizeSelection,
  isOrganizeConfigured, isDigest, suggestTitle,
} from '../core/organize.js';
import {
  askWiki, semanticSearch, syncIndex, rebuildIndex, isRagConfigured, isAskConfigured,
} from '../core/rag.js';
import { isAiEditConfigured, streamAiEdit } from '../core/ai-edit.js';
import { classifyAiError, toPublicAiError } from '../core/ai-errors.js';
import { llmConfig } from '../core/llm.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { renderMarkdown } from '../render.js';
import {
  uploadImage, isStorageConfigured, MAX_UPLOAD_BYTES,
  deleteImageByUrl, extractImageUrls,
} from '../core/storage.js';
import { createMcpServer } from '../mcp/server.js';
import {
  mcpBearer, webGuard, getMcpToken, getWebPassword,
  checkCredentials, setSessionCookie, clearSessionCookie, readSession,
} from './auth.js';
import { rateLimit } from './ratelimit.js';
import { renderPage } from './page.js';
import { LOGIN_HTML } from './login.js';

// Derive a short plain-text description from a markdown body:
// the first non-empty, non-heading line.
function deriveDesc(content) {
  for (const line of (content || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.replace(/[*_`>#-]/g, '').trim().slice(0, 160);
  }
  return '';
}

function publicError(err, code) {
  return {
    ...(code ? { code } : {}),
    error: err?.message || String(err || 'Unknown error'),
  };
}

function validateAiEditBody(body) {
  const mode = body?.mode ?? 'selection';
  if (!['selection', 'document', 'general'].includes(mode)) {
    return '不支持的 AI 编辑模式';
  }
  if (!Array.isArray(body?.messages)) return 'messages 必须是数组';
  for (const message of body.messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      return '消息角色仅支持 user 或 assistant';
    }
    if (typeof message.content !== 'string') return '消息内容必须是字符串';
    if (
      message.contextMode !== undefined
      && !['selection', 'document', 'general'].includes(message.contextMode)
    ) {
      return 'contextMode 仅支持 selection、document 或 general';
    }
  }
  const instruction = body.messages.at(-1);
  if (instruction?.role !== 'user' || !instruction.content.trim()) {
    return '最后一条消息必须是非空的用户指令';
  }
  if (typeof body.selection !== 'string') return 'selection 必须是字符串';
  if (typeof body.noteContent !== 'string') return 'noteContent 必须是字符串';
  if (mode === 'selection' && !body.selection.trim()) return '选区内容不能为空';
  if (mode === 'document' && !body.noteContent.trim()) return '当前文档内容不能为空';
  if (typeof body.includeNote !== 'boolean') return 'includeNote 必须是布尔值';
  return undefined;
}

export function writeSseEvent(res, event, data, {
  signal,
  onAbort = () => {},
} = {}) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  const wrote = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (wrote !== false) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, abortUpstream = false) => {
      if (settled) return;
      settled = true;
      res.off('drain', handleDrain);
      res.off('close', handleClose);
      signal?.removeEventListener('abort', handleAbort);
      if (abortUpstream) onAbort();
      resolve(value);
    };
    const handleDrain = () => finish(true);
    const handleClose = () => finish(false, true);
    const handleAbort = () => finish(false, true);

    res.on('drain', handleDrain);
    res.on('close', handleClose);
    if (signal?.aborted) handleAbort();
    else signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function safeDiagnosticModel(model) {
  return typeof model === 'string' && model.length > 0
    ? '[configured]'
    : '[unset]';
}

export function createApp({
  editorDistDir,
  isStorageConfigured: storageConfigured = isStorageConfigured,
  uploadImage: uploadImageImpl = uploadImage,
} = {}) {
  const app = express();
  // Behind a reverse proxy (Caddy/Nginx) so req.ip reflects the real client
  // via X-Forwarded-For. Defaults to trusting loopback (proxy on same host).
  // Coerce the env string into the shape Express expects: boolean true/false,
  // a hop count (number), or an IP/subnet list; otherwise fall back to loopback.
  const tp = (process.env.WIKI_TRUST_PROXY || '').trim();
  app.set(
    'trust proxy',
    tp === 'true' ? true
      : tp === 'false' ? false
        : /^\d+$/.test(tp) ? Number(tp)
          : tp || 'loopback',
  );
  app.use(express.json({ limit: '5mb' }));

  // Serve packaged brand assets and vendor libraries before the auth guard so
  // the desktop app and login page can load fully offline.
  const webAssets = path.resolve(fileURLToPath(import.meta.url), '../assets');
  app.use('/assets', express.static(webAssets, { maxAge: '7d', index: false }));

  const nodeModules = path.resolve(fileURLToPath(import.meta.url), '../../../node_modules');
  app.use('/vendor/highlight.js', express.static(path.join(nodeModules, 'highlight.js/styles'), {
    maxAge: '7d', index: false,
  }));
  app.use('/vendor/mermaid', express.static(path.join(nodeModules, 'mermaid/dist'), {
    maxAge: '7d', index: false,
  }));

  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.WIKI_MCP_RATE_LIMIT) || 120,
  });
  const uploadLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.WIKI_UPLOAD_RATE_LIMIT) || 30,
  });
  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.WIKI_LOGIN_RATE_LIMIT) || 10,
  });

  // --- MCP over HTTP (Streamable HTTP, stateless) ---
  // Registered before the Basic-auth guard so it uses its own Bearer-token auth.
  // Rate limit runs first so unauthenticated floods are throttled too.
  // Cursor / Claude connect here with an `Authorization: Bearer <WIKI_TOKEN>` header.
  app.post('/mcp', mcpLimiter, mcpBearer, async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({ error: 'Use POST for MCP' }));

  // --- Auth: login page + session endpoints (registered before the guard) ---
  app.get('/login', (req, res) => {
    // No password configured, or already logged in → go straight to the app.
    if (!getWebPassword() || readSession(req)) return res.redirect(302, '/');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('html').send(LOGIN_HTML);
  });
  app.post('/login', loginLimiter, (req, res) => {
    const { user, password } = req.body || {};
    if (checkCredentials(user, password)) {
      setSessionCookie(req, res, user || 'wiki');
      return res.json({ ok: true });
    }
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid credentials' });
  });
  app.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.get('/api/auth/status', (req, res) => {
    res.json({ required: !!getWebPassword(), authed: !getWebPassword() || !!readSession(req) });
  });

  // Everything below (web UI + REST API) is guarded by session/Basic auth
  // when a password is configured. Redirects browsers to /login; 401 for API.
  app.use(webGuard);

  const resolvedEditorDistDir = path.resolve(
    editorDistDir || fileURLToPath(new URL('../../web-dist/editor', import.meta.url)),
  );
  app.use('/editor-assets', (req, res, next) => {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      return res.status(404).end();
    }
    const candidate = path.resolve(resolvedEditorDistDir, `.${decodedPath}`);
    if (candidate !== resolvedEditorDistDir && !candidate.startsWith(`${resolvedEditorDistDir}${path.sep}`)) {
      return res.status(404).end();
    }
    return next();
  });
  app.use('/editor-assets', express.static(resolvedEditorDistDir, {
    fallthrough: false,
    index: false,
    dotfiles: 'deny',
  }));
  app.use('/editor-assets', (err, _req, res, next) => {
    if (!err) return next();
    if (err.status === 403 || err.status === 404) {
      return res.status(err.status).end();
    }
    return next(err);
  });

  // --- API ---
  app.get('/api/tree', async (_req, res) => {
    res.json(await listTree());
  });

  // Editorial index: every note with folder / date / title / description,
  // newest first. Powers the OpenAI-style home listing.
  app.get('/api/index', async (_req, res) => {
    const notes = await getAllNotes();
    const items = notes.map(({ path: p, data, content, mtimeMs }) => {
      const name = p.split('/').pop().replace(/\.md$/, '');
      const folder = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      // Fall back to file mtime so every note always has a date to show.
      let date = (data.savedAt || data.date || '').toString();
      if (!date && mtimeMs) date = new Date(mtimeMs).toISOString();
      return {
        path: p,
        folder,
        title: (data.title || name).toString(),
        date,
        desc: deriveDesc(content),
        categories: normalizeCategoryList(data.categories),
        // Synthesized category digests are surfaced as banner cards, not rows.
        digest: !!data.digest,
        // Custom (hand-picked) syntheses DO appear in their category listing.
        custom: !!data.custom,
        category: (data.category || '').toString(),
        tidied: !!data.tidied,
      };
    });
    items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path));
    res.json(items);
  });

  app.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json([]);
    res.json(await searchNotes(q));
  });

  app.get('/api/note', async (req, res) => {
    const p = (req.query.path || '').toString();
    try {
      const note = await readNoteVersioned(p);
      res.json({ ...note, html: renderMarkdown(note.content) });
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      res.status(400).json({
        code: 'NOTE_READ_FAILED',
        error: 'Unable to read note',
      });
    }
  });

  app.put('/api/note', async (req, res) => {
    const {
      path: p,
      content,
      markdown,
      frontmatter,
      autoClassify,
      unique,
      baseVersion,
    } = req.body || {};
    try {
      if (typeof p !== 'string' || !p.trim()) {
        return res.status(400).json({ error: 'path is required' });
      }
      const hasBaseVersion = Object.hasOwn(req.body || {}, 'baseVersion');
      if (hasBaseVersion && (typeof baseVersion !== 'string' || !/^[a-f0-9]{64}$/.test(baseVersion))) {
        return res.status(400).json({ error: 'baseVersion must be a SHA-256 hex digest' });
      }
      // For new notes, avoid clobbering an existing file with the same path.
      const target = unique ? await nextAvailablePath(p) : p;
      // Preserve existing frontmatter (title/savedAt/categories) across edits;
      // only override keys explicitly passed in.
      let base = {};
      let existingNote;
      if (await noteExists(target)) {
        existingNote = await readNote(target);
        base = existingNote.data || {};
      }
      const merged = { ...base, ...(frontmatter || {}) };
      const nextContent = markdown ?? content ?? '';
      let saved;
      let version;
      try {
        if (hasBaseVersion) {
          ({ path: saved, version } = await writeNoteVersioned(target, nextContent, {
            frontmatter: merged,
            baseVersion,
          }));
        } else {
          saved = await writeNote(target, nextContent, { frontmatter: merged });
        }
      } catch (error) {
        if (error.code !== 'NOTE_VERSION_CONFLICT') throw error;
        const conflictBase = `${target.replace(/\.md$/i, '')}-conflict-local.md`;
        let conflictPath;
        for (;;) {
          const candidate = await nextAvailablePath(conflictBase);
          try {
            conflictPath = await writeNote(candidate, nextContent, {
              frontmatter: merged,
              mode: 'skip',
            });
            break;
          } catch (copyError) {
            if (!/note already exists:/.test(copyError.message)) throw copyError;
          }
        }
        return res.status(409).json({
          code: 'NOTE_VERSION_CONFLICT',
          conflictPath,
          currentVersion: error.currentVersion,
        });
      }

      // Auto-classify when configured and the note has no categories yet.
      // Skip digests (synthesized articles) so they don't pollute categories.
      let categories = normalizeCategoryList(merged.categories);
      if (autoClassify !== false && !categories.length && !isDigest({ path: saved, data: merged })) {
        categories = await autoTagIfEmpty(saved);
      }
      if (!version || categories.length) {
        version = (await readNoteVersioned(saved)).version;
      }
      res.json({ ok: true, path: saved, categories, version });
    } catch (err) {
      res.status(400).json({
        code: 'NOTE_SAVE_FAILED',
        error: 'Unable to save note',
      });
    }
  });

  // Rename / move a note to a new path.
  app.post('/api/note/rename', async (req, res) => {
    const { from, to } = req.body || {};
    try {
      if (!from || !to) return res.status(400).json({ error: 'from/to required' });
      if (!(await noteExists(from))) return res.status(404).json({ error: 'not found' });
      const saved = await moveNote(from, to);
      // The UI shows the frontmatter `title`, not the filename, so a path-only
      // rename would leave the visible name unchanged. Keep the title in sync
      // with the new leaf filename so renaming updates both.
      const title = saved.split('/').pop().replace(/\.md$/i, '');
      if (title) await updateFrontmatter(saved, { title });
      res.json({ ok: true, path: saved, title });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Render markdown → HTML (used by the editor's live preview).
  app.post('/api/render', (req, res) => {
    res.json({ html: renderMarkdown((req.body?.content || '').toString()) });
  });

  app.delete('/api/note', async (req, res) => {
    const p = (req.query.path || '').toString();
    try {
      // Best-effort: remove images this note uploaded so they don't orphan.
      if (isStorageConfigured() && await noteExists(p)) {
        try {
          const { content } = await readNote(p);
          for (const url of extractImageUrls(content)) {
            try { await deleteImageByUrl(url); }
            catch (e) { console.warn('image cleanup failed:', url, e.message); }
          }
        } catch { /* ignore */ }
      }
      await deleteNote(p);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // --- Categories ---
  app.get('/api/classify/status', (_req, res) => {
    res.json({ enabled: isClassifyConfigured() });
  });

  app.get('/api/ai/edit/status', (_req, res) => {
    res.json({ enabled: isAiEditConfigured() });
  });

  app.post('/api/ai/edit/chat', async (req, res) => {
    const requestId = randomUUID();
    const validationError = validateAiEditBody(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!isAiEditConfigured()) {
      return res.status(400).json({
        code: 'LLM_NOT_CONFIGURED',
        error: 'AI editing is not configured',
      });
    }

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const controller = new AbortController();
    let ended = false;
    const abortOnRequestClose = () => {
      if ((!req.complete || req.aborted) && !res.writableEnded) controller.abort();
    };
    const abortOnResponseClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    const endOnce = () => {
      if (ended) return;
      ended = true;
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    req.on('close', abortOnRequestClose);
    res.on('close', abortOnResponseClose);

    try {
      for await (const text of streamAiEdit(req.body, { signal: controller.signal })) {
        if (res.destroyed || res.writableEnded) break;
        const wrote = await writeSseEvent(res, 'delta', { text }, {
          signal: controller.signal,
          onAbort: () => controller.abort(),
        });
        if (!wrote) break;
      }
      if (!res.destroyed && !res.writableEnded && !controller.signal.aborted) {
        await writeSseEvent(res, 'done', {}, {
          signal: controller.signal,
          onAbort: () => controller.abort(),
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const classified = classifyAiError(error);
        const config = llmConfig();
        let providerHost;
        try {
          providerHost = new URL(config.baseUrl).hostname;
        } catch {
          providerHost = undefined;
        }
        console.error('AI edit upstream failure', {
          requestId,
          code: classified.code,
          status: classified.status,
          providerHost,
          model: safeDiagnosticModel(config.model),
        });
        if (!res.destroyed && !res.writableEnded) {
          await writeSseEvent(res, 'error', toPublicAiError(error, requestId), {
            signal: controller.signal,
            onAbort: () => controller.abort(),
          });
        }
      }
    } finally {
      req.off('close', abortOnRequestClose);
      res.off('close', abortOnResponseClose);
      endOnce();
    }
  });

  // Whether AI organize (tidy + synthesize) is available (same LLM config).
  app.get('/api/organize/status', (_req, res) => {
    res.json({ enabled: isOrganizeConfigured() });
  });

  // Tidy a saved note's body in place: AI cleans up formatting, keeps facts.
  app.post('/api/tidy', async (req, res) => {
    const p = (req.body?.path || '').toString();
    try {
      if (!(await noteExists(p))) return res.status(404).json({ error: 'not found' });
      const r = await tidyAndSet(p);
      res.json({ ok: true, path: r.path, html: renderMarkdown(r.content) });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isOrganizeConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // Non-destructive tidy: return cleaned markdown without saving (editor use).
  app.post('/api/tidy/preview', async (req, res) => {
    try {
      const content = (req.body?.content || '').toString();
      const title = (req.body?.title || '').toString();
      const tidied = await tidyMarkdown({ title, content });
      res.json({ ok: true, content: tidied });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isOrganizeConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // Suggest a concise title from a body (used by the "新建" draft flow).
  app.post('/api/title', async (req, res) => {
    try {
      const title = await suggestTitle({ content: (req.body?.content || '').toString() });
      res.json({ ok: true, title });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isOrganizeConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // (Re)synthesize a category digest from all notes in that category.
  app.post('/api/digest', async (req, res) => {
    const category = (req.body?.category || '').toString();
    try {
      const r = await synthesizeCategory(category);
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isOrganizeConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // Synthesize one article from a hand-picked set of notes (ad-hoc digest).
  app.post('/api/digest/custom', async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String) : [];
    const title = (req.body?.title || '').toString();
    try {
      const r = await synthesizeSelection(paths, { title });
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isOrganizeConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // --- RAG: semantic search + "ask your wiki" ---
  app.get('/api/rag/status', (_req, res) => {
    res.json({ enabled: isAskConfigured() });
  });

  // Natural-language question answered from the notes, with source links.
  app.post('/api/ask', async (req, res) => {
    const question = (req.body?.question || '').toString();
    try {
      const r = await askWiki(question);
      res.json({ ok: true, answer: r.answer, html: renderMarkdown(r.answer), sources: r.sources });
    } catch (err) {
      const code = !isRagConfigured()
        ? 'RAG_NOT_CONFIGURED'
        : !isAskConfigured() ? 'LLM_NOT_CONFIGURED' : undefined;
      res.status(400).json(publicError(
        err,
        code,
      ));
    }
  });

  // Semantic (vector) search → ranked notes with a snippet.
  app.get('/api/search/semantic', async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json([]);
    try {
      const hits = await semanticSearch(q, 10);
      // Collapse to one row per note (keep the best-scoring chunk as snippet).
      const byPath = new Map();
      for (const h of hits) {
        if (!byPath.has(h.path)) byPath.set(h.path, { path: h.path, title: h.title, snippet: h.text.slice(0, 160) });
      }
      res.json([...byPath.values()]);
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isRagConfigured() ? undefined : 'RAG_NOT_CONFIGURED',
      ));
    }
  });

  // Rebuild the whole vector index from scratch.
  app.post('/api/reindex', async (_req, res) => {
    try {
      const stats = await rebuildIndex();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isRagConfigured() ? undefined : 'RAG_NOT_CONFIGURED',
      ));
    }
  });

  app.get('/api/categories', async (_req, res) => {
    res.json(await listCategories());
  });

  // Manually set a note's categories.
  app.put('/api/note/categories', async (req, res) => {
    const { path: p, categories } = req.body || {};
    try {
      const saved = await setNoteCategories(p, categories || []);
      res.json({ ok: true, path: saved, categories: normalizeCategoryList(categories) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Rename / merge a category across all notes.
  app.post('/api/categories/rename', async (req, res) => {
    const { from, to } = req.body || {};
    try {
      const changed = await renameCategory((from || '').trim(), (to || '').trim());
      res.json({ ok: true, changed });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Remove a category from all notes.
  app.post('/api/categories/delete', async (req, res) => {
    try {
      const changed = await deleteCategory((req.body?.name || '').trim());
      res.json({ ok: true, changed });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // (Re)classify a single note now.
  app.post('/api/classify', async (req, res) => {
    const p = (req.body?.path || '').toString();
    try {
      if (!(await noteExists(p))) return res.status(404).json({ error: 'not found' });
      const categories = await classifyAndSet(p);
      res.json({ ok: true, path: p, categories });
    } catch (err) {
      res.status(400).json(publicError(
        err,
        isClassifyConfigured() ? undefined : 'LLM_NOT_CONFIGURED',
      ));
    }
  });

  // Batch-classify. By default only notes that have no categories yet;
  // pass { all: true } to reclassify everything.
  app.post('/api/classify/all', async (req, res) => {
    if (!isClassifyConfigured()) {
      return res.status(400).json({
        code: 'LLM_NOT_CONFIGURED',
        error: 'Automatic classification is not configured',
      });
    }
    const all = req.body?.all === true;
    const concurrency = Math.max(1, Number(process.env.WIKI_CLASSIFY_CONCURRENCY) || 3);
    try {
      const notes = await getAllNotes();
      const targets = notes
        .filter((n) => all || !normalizeCategoryList(n.data.categories).length)
        .map((n) => n.path);

      const results = [];
      let idx = 0;
      const worker = async () => {
        while (idx < targets.length) {
          const p = targets[idx++];
          try {
            const categories = await classifyAndSet(p);
            results.push({ path: p, categories });
          } catch (e) {
            results.push({ path: p, error: e.message });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, worker),
      );
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Tells the frontend whether image upload is available.
  app.get('/api/upload/status', (_req, res) => {
    res.json({ enabled: storageConfigured() });
  });

  // Image upload → S3-compatible object storage. Body is the raw image bytes;
  // the original filename comes in via the X-Filename header.
  app.post(
    '/api/upload',
    uploadLimiter,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      if (!storageConfigured()) {
        return res.status(400).json({
          code: 'STORAGE_NOT_CONFIGURED',
          error: 'Image storage is not configured',
        });
      }
      try {
        const contentType = req.get('content-type');
        if (!contentType?.startsWith('image/')) {
          return res.status(400).json({
            code: 'INVALID_IMAGE',
            error: '不支持的图片类型',
          });
        }
        let filename = 'image';
        try {
          filename = decodeURIComponent(req.get('x-filename') || 'image');
        } catch {
          return res.status(400).json({
            code: 'INVALID_FILENAME',
            error: '图片文件名无效',
          });
        }
        const { url } = await uploadImageImpl(req.body, { filename, contentType });
        res.json({ ok: true, url });
      } catch {
        res.status(502).json({
          code: 'UPLOAD_FAILED',
          error: '图片上传失败，请稍后重试',
        });
      }
    },
  );
  app.use('/api/upload', (err, _req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({
        code: 'UPLOAD_TOO_LARGE',
        error: '图片文件过大',
      });
    }
    return next(err);
  });

  // --- Frontend (single self-contained page) ---
  app.get('*', (_req, res) => {
    const locale = process.env.WIKINEST_LOCALE || 'zh-CN';
    res.type('html').send(renderPage(locale));
  });

  return app;
}

export function startServer({
  port = 4321,
  host,
  editorDistDir,
  isStorageConfigured,
  uploadImage,
} = {}) {
  const app = createApp({ editorDistDir, isStorageConfigured, uploadImage });
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      console.log(`📚 Wikinest running at http://${host || 'localhost'}:${actualPort}`);
      console.log(`   content dir: ${CONTENT_DIR}`);
      console.log(`   MCP endpoint: POST /mcp`);
      if (getWebPassword()) console.log('   web auth: login page + session ENABLED');
      else console.warn('   ⚠️  web auth: DISABLED (set WIKI_PASSWORD before exposing publicly)');
      if (getMcpToken()) console.log('   MCP auth: Bearer token ENABLED');
      else console.warn('   ⚠️  MCP auth: DISABLED — /mcp is publicly writable! set WIKI_TOKEN before exposing');
      resolve(server);
    });
  });
}
