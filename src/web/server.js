import express from 'express';
import {
  listTree, readNote, writeNote, deleteNote, searchNotes, noteExists,
  CONTENT_DIR, getAllNotes, nextAvailablePath, moveNote,
  normalizeCategoryList, setNoteCategories, listCategories, renameCategory, deleteCategory,
} from '../core/store.js';
import { classifyAndSet, autoTagIfEmpty, isClassifyConfigured } from '../core/classify.js';
import {
  tidyAndSet, tidyMarkdown, synthesizeCategory, synthesizeSelection,
  isOrganizeConfigured, isDigest, suggestTitle,
} from '../core/organize.js';
import { askWiki, semanticSearch, syncIndex, rebuildIndex, isRagConfigured } from '../core/rag.js';
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
import { PAGE_HTML } from './page.js';
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

export function createApp() {
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
    res.type('html').send(LOGIN_HTML);
  });
  app.post('/login', loginLimiter, (req, res) => {
    const { user, password } = req.body || {};
    if (checkCredentials(user, password)) {
      setSessionCookie(req, res, user || 'wiki');
      return res.json({ ok: true });
    }
    res.status(401).json({ error: '密码错误' });
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
      if (!(await noteExists(p))) return res.status(404).json({ error: 'not found' });
      const note = await readNote(p);
      res.json({ ...note, html: renderMarkdown(note.content) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/note', async (req, res) => {
    const { path: p, content, frontmatter, autoClassify, unique } = req.body || {};
    try {
      // For new notes, avoid clobbering an existing file with the same path.
      const target = unique ? await nextAvailablePath(p) : p;
      // Preserve existing frontmatter (title/savedAt/categories) across edits;
      // only override keys explicitly passed in.
      let base = {};
      if (await noteExists(target)) base = (await readNote(target)).data || {};
      const merged = { ...base, ...(frontmatter || {}) };
      const saved = await writeNote(target, content ?? '', { frontmatter: merged });

      // Auto-classify when configured and the note has no categories yet.
      // Skip digests (synthesized articles) so they don't pollute categories.
      let categories = normalizeCategoryList(merged.categories);
      if (autoClassify !== false && !categories.length && !isDigest({ path: saved, data: merged })) {
        categories = await autoTagIfEmpty(saved);
      }
      res.json({ ok: true, path: saved, categories });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Rename / move a note to a new path.
  app.post('/api/note/rename', async (req, res) => {
    const { from, to } = req.body || {};
    try {
      if (!from || !to) return res.status(400).json({ error: 'from/to required' });
      if (!(await noteExists(from))) return res.status(404).json({ error: 'not found' });
      const saved = await moveNote(from, to);
      res.json({ ok: true, path: saved });
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
      res.status(400).json({ error: err.message });
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
      res.status(400).json({ error: err.message });
    }
  });

  // Suggest a concise title from a body (used by the "新建" draft flow).
  app.post('/api/title', async (req, res) => {
    try {
      const title = await suggestTitle({ content: (req.body?.content || '').toString() });
      res.json({ ok: true, title });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // (Re)synthesize a category digest from all notes in that category.
  app.post('/api/digest', async (req, res) => {
    const category = (req.body?.category || '').toString();
    try {
      const r = await synthesizeCategory(category);
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
      res.status(400).json({ error: err.message });
    }
  });

  // --- RAG: semantic search + "ask your wiki" ---
  app.get('/api/rag/status', (_req, res) => {
    res.json({ enabled: isRagConfigured() });
  });

  // Natural-language question answered from the notes, with source links.
  app.post('/api/ask', async (req, res) => {
    const question = (req.body?.question || '').toString();
    try {
      const r = await askWiki(question);
      res.json({ ok: true, answer: r.answer, html: renderMarkdown(r.answer), sources: r.sources });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
      res.status(400).json({ error: err.message });
    }
  });

  // Rebuild the whole vector index from scratch.
  app.post('/api/reindex', async (_req, res) => {
    try {
      const stats = await rebuildIndex();
      res.json({ ok: true, ...stats });
    } catch (err) {
      res.status(400).json({ error: err.message });
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
      res.status(400).json({ error: err.message });
    }
  });

  // Batch-classify. By default only notes that have no categories yet;
  // pass { all: true } to reclassify everything.
  app.post('/api/classify/all', async (req, res) => {
    if (!isClassifyConfigured()) return res.status(400).json({ error: '自动分类未配置' });
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
    res.json({ enabled: isStorageConfigured() });
  });

  // Image upload → S3-compatible object storage. Body is the raw image bytes;
  // the original filename comes in via the X-Filename header.
  app.post(
    '/api/upload',
    uploadLimiter,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      try {
        const contentType = req.get('content-type');
        const filename = decodeURIComponent(req.get('x-filename') || 'image');
        const { url } = await uploadImage(req.body, { filename, contentType });
        res.json({ ok: true, url });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  // --- Frontend (single self-contained page) ---
  app.get('*', (_req, res) => {
    res.type('html').send(PAGE_HTML);
  });

  return app;
}

export function startServer({ port = 4321 } = {}) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`📚 personal-wiki running at http://localhost:${port}`);
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
