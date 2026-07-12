import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// content/ lives at the repo root, next to src/
export const CONTENT_DIR = process.env.WIKI_CONTENT_DIR
  ? path.resolve(process.env.WIKI_CONTENT_DIR)
  : path.resolve(__dirname, '..', '..', 'content');

/**
 * Resolve a wiki-relative path to an absolute path, guaranteeing it stays
 * inside CONTENT_DIR. Throws on traversal attempts (../, absolute paths).
 * Always normalizes to a .md file.
 */
export function resolveNotePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('path is required');
  }
  // Strip leading slashes so absolute-looking paths are treated as relative.
  let clean = relPath.replace(/^[/\\]+/, '');
  if (!clean.toLowerCase().endsWith('.md')) clean += '.md';

  const abs = path.resolve(CONTENT_DIR, clean);
  const rel = path.relative(CONTENT_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes content directory: ${relPath}`);
  }
  return abs;
}

/** Convert an absolute path back to a wiki-relative POSIX path (no .md hidden). */
export function toRelPath(abs) {
  return path.relative(CONTENT_DIR, abs).split(path.sep).join('/');
}

async function ensureContentDir() {
  await fs.mkdir(CONTENT_DIR, { recursive: true });
}

/** Recursively list all notes as a nested tree of folders and files. */
export async function listTree(dir = CONTENT_DIR) {
  await ensureContentDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await listTree(abs);
      nodes.push({ type: 'dir', name: entry.name, path: toRelPath(abs), children });
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      nodes.push({ type: 'file', name: entry.name, path: toRelPath(abs) });
    }
  }
  // Folders first, then files, each alphabetically.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/** Flat list of every note path — handy for search and CLI listing. */
export async function listFlat(dir = CONTENT_DIR, acc = []) {
  await ensureContentDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFlat(abs, acc);
    else if (entry.name.toLowerCase().endsWith('.md')) acc.push(toRelPath(abs));
  }
  return acc;
}

/** Read a note; returns { data (frontmatter), content (body), raw }. */
export async function readNote(relPath) {
  const abs = resolveNotePath(relPath);
  const raw = await fs.readFile(abs, 'utf8');
  const { data, content } = matter(raw);
  return { path: toRelPath(abs), data, content, raw };
}

export async function noteExists(relPath) {
  try {
    await fs.access(resolveNotePath(relPath));
    return true;
  } catch {
    return false;
  }
}

// Parsed-note cache keyed by path, invalidated by file mtime. Avoids
// re-reading + re-parsing unchanged files on every index/search/category scan.
const _noteCache = new Map();

/**
 * Read every note, using the cache for files whose mtime hasn't changed.
 * @returns {Promise<Array<{ path, data, content, mtimeMs }>>}
 */
export async function getAllNotes() {
  const paths = await listFlat();
  const out = [];
  for (const p of paths) {
    const abs = resolveNotePath(p);
    let mtimeMs = 0;
    try { mtimeMs = (await fs.stat(abs)).mtimeMs; } catch { continue; }
    let e = _noteCache.get(p);
    if (!e || e.mtimeMs !== mtimeMs) {
      const raw = await fs.readFile(abs, 'utf8');
      const { data, content } = matter(raw);
      e = { mtimeMs, data, content };
      _noteCache.set(p, e);
    }
    out.push({ path: p, data: e.data, content: e.content, mtimeMs });
  }
  // Drop cache entries for notes that no longer exist.
  const alive = new Set(paths);
  for (const k of _noteCache.keys()) if (!alive.has(k)) _noteCache.delete(k);
  return out;
}

/**
 * Write a note. `frontmatter` is merged into the file's YAML header.
 * `mode` = 'overwrite' (default) | 'append' | 'skip' (fail if exists).
 */
export async function writeNote(relPath, body, { frontmatter = {}, mode = 'overwrite' } = {}) {
  const abs = resolveNotePath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const exists = await noteExists(relPath);
  if (mode === 'skip' && exists) {
    throw new Error(`note already exists: ${toRelPath(abs)}`);
  }

  if (mode === 'append' && exists) {
    const current = await fs.readFile(abs, 'utf8');
    const parsed = matter(current);
    const mergedData = { ...parsed.data, ...frontmatter };
    const newBody = parsed.content.replace(/\s+$/, '') + '\n\n' + body.trim() + '\n';
    await fs.writeFile(abs, matter.stringify(newBody, mergedData));
  } else {
    await fs.writeFile(abs, matter.stringify('\n' + body.trim() + '\n', frontmatter));
  }
  return toRelPath(abs);
}

export async function deleteNote(relPath) {
  const abs = resolveNotePath(relPath);
  await fs.unlink(abs);
  return toRelPath(abs);
}

/**
 * Return a non-colliding note path: if `relPath` is free, return it (as a
 * .md rel path); otherwise append -2, -3, … until a free one is found.
 */
export async function nextAvailablePath(relPath) {
  if (!(await noteExists(relPath))) return toRelPath(resolveNotePath(relPath));
  const base = toRelPath(resolveNotePath(relPath)).replace(/\.md$/i, '');
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!(await noteExists(cand))) return toRelPath(resolveNotePath(cand));
  }
}

/** Move/rename a note to a new path, preserving frontmatter + body verbatim. */
export async function moveNote(from, to, { overwrite = false } = {}) {
  const src = resolveNotePath(from);
  const raw = await fs.readFile(src, 'utf8');
  if (!overwrite && await noteExists(to)) {
    throw new Error(`目标已存在: ${toRelPath(resolveNotePath(to))}`);
  }
  const dest = resolveNotePath(to);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, raw);
  if (toRelPath(dest) !== toRelPath(src)) await fs.unlink(src);
  return toRelPath(dest);
}

/** Normalize a frontmatter categories value into a clean string array. */
export function normalizeCategoryList(value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(
    arr.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean),
  )];
}

/**
 * Update only the frontmatter of a note, leaving the body untouched.
 * `patch` is merged into existing frontmatter (undefined values delete keys).
 */
export async function updateFrontmatter(relPath, patch) {
  const abs = resolveNotePath(relPath);
  const raw = await fs.readFile(abs, 'utf8');
  const { data, content } = matter(raw);
  const merged = { ...data };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  await fs.writeFile(abs, matter.stringify(content, merged));
  return toRelPath(abs);
}

/** Set (replace) a note's categories. */
export async function setNoteCategories(relPath, categories) {
  const cats = normalizeCategoryList(categories);
  return updateFrontmatter(relPath, { categories: cats.length ? cats : undefined });
}

/** Aggregate all categories across the wiki with per-category note counts. */
export async function listCategories() {
  const notes = await getAllNotes();
  const counts = new Map();
  for (const { data } of notes) {
    for (const c of normalizeCategoryList(data.categories)) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Rename (or merge into) a category across every note that uses it. */
export async function renameCategory(from, to) {
  const target = (to || '').trim();
  if (!from || !target) throw new Error('from/to are required');
  const paths = await listFlat();
  let changed = 0;
  for (const p of paths) {
    const { data } = await readNote(p);
    const cats = normalizeCategoryList(data.categories);
    if (!cats.includes(from)) continue;
    const next = normalizeCategoryList(cats.map((c) => (c === from ? target : c)));
    await updateFrontmatter(p, { categories: next.length ? next : undefined });
    changed++;
  }
  return changed;
}

/** Remove a category from every note that uses it. */
export async function deleteCategory(name) {
  if (!name) throw new Error('name is required');
  const paths = await listFlat();
  let changed = 0;
  for (const p of paths) {
    const { data } = await readNote(p);
    const cats = normalizeCategoryList(data.categories);
    if (!cats.includes(name)) continue;
    const next = cats.filter((c) => c !== name);
    await updateFrontmatter(p, { categories: next.length ? next : undefined });
    changed++;
  }
  return changed;
}

/** Case-insensitive full-text search over title, path and body. */
export async function searchNotes(query) {
  const q = query.toLowerCase();
  const notes = await getAllNotes();
  const hits = [];
  for (const { path: p, data, content } of notes) {
    const title = (data.title || p).toString();
    const haystack = (title + '\n' + content).toLowerCase();
    const idx = haystack.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const snippet = haystack.slice(start, idx + q.length + 40).replace(/\s+/g, ' ').trim();
      hits.push({ path: p, title, snippet });
    }
  }
  return hits;
}
