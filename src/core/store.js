import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { CONTENT_KINDS, contentKind } from './content-kind.js';

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

// Tail promises serialize mutations to one absolute path while leaving
// unrelated paths independent. Multi-path callers acquire in sorted order.
const _pathLockTails = new Map();
const _pathGenerations = new Map();
const _noteReadGenerations = new WeakMap();
let _tempSequence = 0;
let _mutationObserver = null;

// APFS/HFS+ and Windows commonly identify NFC/case aliases as one file. Use a
// conservative identity everywhere so aliases cannot bypass locks or cache
// generations even when tests run on a case-sensitive filesystem.
function pathIdentity(abs) {
  return abs.normalize('NFC').toLowerCase();
}

function pathGeneration(abs) {
  return _pathGenerations.get(pathIdentity(abs)) || 0;
}

async function acquirePathLock(key) {
  const previous = _pathLockTails.get(key) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  _pathLockTails.set(key, tail);
  await previous.catch(() => {});
  return () => {
    releaseGate();
    if (_pathLockTails.get(key) === tail) _pathLockTails.delete(key);
  };
}

async function withPathLocks(paths, operation) {
  const releases = [];
  const ordered = [...new Set(paths.map(pathIdentity))].sort();
  try {
    for (const key of ordered) releases.push(await acquirePathLock(key));
    return await operation();
  } finally {
    for (let i = releases.length - 1; i >= 0; i--) releases[i]();
  }
}

async function atomicWriteFile(abs, raw, beforeRename) {
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(abs)}.${process.pid}.${++_tempSequence}.tmp`,
  );
  try {
    await fs.writeFile(temp, raw);
    await beforeRename?.();
    await fs.rename(temp, abs);
  } catch (error) {
    try {
      await fs.unlink(temp);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          `atomic write failed: ${error.message}; temp cleanup failed: ${cleanupError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function invalidateNoteCaches(...absolutePaths) {
  const identities = new Set(absolutePaths.map(pathIdentity));
  for (const identity of identities) {
    _pathGenerations.set(identity, (_pathGenerations.get(identity) || 0) + 1);
  }
  for (const rel of _noteCache.keys()) {
    if (identities.has(pathIdentity(resolveNotePath(rel)))) _noteCache.delete(rel);
  }
  for (const rel of _searchCache.keys()) {
    if (identities.has(pathIdentity(resolveNotePath(rel)))) _searchCache.delete(rel);
  }
}

function notifyMutation(event) {
  if (!_mutationObserver) return;
  try {
    Promise.resolve(_mutationObserver(event)).catch(() => {});
  } catch {
    // A write is already durable; observer failures must not change its result.
  }
}

async function currentContentHash(abs) {
  try {
    return createHash('sha256').update(await fs.readFile(abs)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function noteVersion(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

async function readRawOrEmpty(abs) {
  try {
    return await fs.readFile(abs);
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

function versionConflict(currentRaw) {
  const error = new Error('note changed externally');
  error.code = 'NOTE_VERSION_CONFLICT';
  error.currentVersion = noteVersion(currentRaw);
  return error;
}

function assertExpectedContentHash(actual, options) {
  if (!Object.hasOwn(options ?? {}, 'expectedContentHash')) return;
  if (actual === options.expectedContentHash) return;
  const error = new Error('local note changed during sync materialization');
  error.code = 'LOCAL_CHANGED_DURING_SYNC';
  throw error;
}

/**
 * Register the one local-mutation observer. A later registration replaces the
 * previous observer. Returns an idempotent unregister function.
 */
export function setMutationObserver(observer) {
  if (observer !== null && typeof observer !== 'function') {
    throw new TypeError('mutation observer must be a function or null');
  }
  _mutationObserver = observer;
  return () => {
    if (_mutationObserver === observer) _mutationObserver = null;
  };
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

/** Read and parse a note with a version from the exact bytes just read. */
export async function readNoteVersioned(relPath) {
  const abs = resolveNotePath(relPath);
  const bytes = await fs.readFile(abs);
  const raw = bytes.toString('utf8');
  const { data, content } = matter(raw);
  return {
    path: toRelPath(abs),
    data,
    content,
    raw,
    version: noteVersion(bytes),
  };
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
    const generation = pathGeneration(abs);
    let mtimeMs = 0;
    try { mtimeMs = (await fs.stat(abs)).mtimeMs; } catch { continue; }
    let e = _noteCache.get(p);
    if (!e || e.mtimeMs !== mtimeMs) {
      const raw = await fs.readFile(abs, 'utf8');
      const { data, content } = matter(raw);
      e = { mtimeMs, data, content };
      if (pathGeneration(abs) === generation) _noteCache.set(p, e);
    }
    const note = {
      path: p, data: e.data, content: e.content, mtimeMs,
    };
    _noteReadGenerations.set(note, generation);
    out.push(note);
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
  const rel = toRelPath(abs);
  await withPathLocks([abs], async () => {
    let exists = true;
    try { await fs.access(abs); } catch { exists = false; }
    if (mode === 'skip' && exists) {
      throw new Error(`note already exists: ${rel}`);
    }

    let raw;
    if (mode === 'append' && exists) {
      const current = await fs.readFile(abs, 'utf8');
      const parsed = matter(current);
      const mergedData = { ...parsed.data, ...frontmatter };
      const newBody = parsed.content.replace(/\s+$/, '') + '\n\n' + body.trim() + '\n';
      raw = matter.stringify(newBody, mergedData);
    } else {
      raw = matter.stringify('\n' + body.trim() + '\n', frontmatter);
    }
    await atomicWriteFile(abs, raw);
    invalidateNoteCaches(abs);
  });
  notifyMutation({ type: 'upsert', path: rel, origin: 'local' });
  return rel;
}

/**
 * Atomically overwrite a note only when its exact current bytes match the
 * caller's version. Both checks run under the target path's mutation lock.
 */
export async function writeNoteVersioned(relPath, body, { frontmatter = {}, baseVersion } = {}) {
  const abs = resolveNotePath(relPath);
  const rel = toRelPath(abs);
  let writtenRaw;

  await withPathLocks([abs], async () => {
    const currentRaw = await readRawOrEmpty(abs);
    if (noteVersion(currentRaw) !== baseVersion) throw versionConflict(currentRaw);

    writtenRaw = matter.stringify('\n' + body.trim() + '\n', frontmatter);
    await atomicWriteFile(abs, writtenRaw, async () => {
      const beforeRename = await readRawOrEmpty(abs);
      if (noteVersion(beforeRename) !== baseVersion) throw versionConflict(beforeRename);
    });
    invalidateNoteCaches(abs);
  });
  notifyMutation({ type: 'upsert', path: rel, origin: 'local' });
  return { path: rel, version: noteVersion(writtenRaw) };
}

export async function deleteNote(relPath) {
  const abs = resolveNotePath(relPath);
  const rel = toRelPath(abs);
  await withPathLocks([abs], async () => {
    await fs.unlink(abs);
    invalidateNoteCaches(abs);
  });
  notifyMutation({ type: 'delete', path: rel, origin: 'local' });
  return rel;
}

/** Apply raw Markdown received from sync without creating a local mutation. */
export async function applyRawNote(relPath, raw, options = {}) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    throw new TypeError('raw Markdown must be a string or Buffer');
  }
  const abs = resolveNotePath(relPath);
  const rel = toRelPath(abs);
  await withPathLocks([abs], async () => {
    assertExpectedContentHash(await currentContentHash(abs), options);
    await atomicWriteFile(abs, raw, async () => {
      assertExpectedContentHash(await currentContentHash(abs), options);
    });
    invalidateNoteCaches(abs);
  });
  return { path: rel, origin: 'sync' };
}

/** Delete a note received from sync without creating a local mutation. */
export async function deleteRawNote(relPath, options = {}) {
  const abs = resolveNotePath(relPath);
  const rel = toRelPath(abs);
  await withPathLocks([abs], async () => {
    const actual = await currentContentHash(abs);
    assertExpectedContentHash(actual, options);
    if (actual === null) return;
    assertExpectedContentHash(await currentContentHash(abs), options);
    await fs.unlink(abs);
    invalidateNoteCaches(abs);
  });
  return { path: rel, origin: 'sync' };
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
  const dest = resolveNotePath(to);
  const fromRel = toRelPath(src);
  const destRel = toRelPath(dest);
  await withPathLocks([src, dest], async () => {
    const srcStat = await fs.stat(src);
    if (!overwrite && src !== dest) {
      try {
        const destStat = await fs.stat(dest);
        const isSameFile = srcStat.dev === destStat.dev && srcStat.ino === destStat.ino;
        if (!isSameFile) throw new Error(`目标已存在: ${destRel}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    invalidateNoteCaches(src, dest);
  });
  notifyMutation({
    type: 'move', from: fromRel, path: destRel, origin: 'local',
  });
  return destRel;
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
  const rel = toRelPath(abs);
  await withPathLocks([abs], async () => {
    const raw = await fs.readFile(abs, 'utf8');
    const { data, content } = matter(raw);
    const merged = { ...data };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    await atomicWriteFile(abs, matter.stringify(content, merged));
    invalidateNoteCaches(abs);
  });
  notifyMutation({ type: 'upsert', path: rel, origin: 'local' });
  return rel;
}

/** Set (replace) a note's categories. */
export async function setNoteCategories(relPath, categories) {
  const { data } = await readNote(relPath);
  if (contentKind(data) !== CONTENT_KINDS.NOTE) {
    throw new Error('categories are only available for knowledge notes');
  }
  const cats = normalizeCategoryList(categories);
  return updateFrontmatter(relPath, { categories: cats.length ? cats : undefined });
}

/** Aggregate all categories across the wiki with per-category note counts. */
export async function listCategories() {
  const notes = await getAllNotes();
  const counts = new Map();
  for (const { data } of notes) {
    if (contentKind(data) !== CONTENT_KINDS.NOTE) continue;
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
    if (contentKind(data) !== CONTENT_KINDS.NOTE) continue;
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
    if (contentKind(data) !== CONTENT_KINDS.NOTE) continue;
    const cats = normalizeCategoryList(data.categories);
    if (!cats.includes(name)) continue;
    const next = cats.filter((c) => c !== name);
    await updateFrontmatter(p, { categories: next.length ? next : undefined });
    changed++;
  }
  return changed;
}

// Parse a query into lowercase terms. Supports "quoted phrases" (kept whole)
// and space-separated words; duplicates are collapsed. All terms must match
// (AND), which gives multi-keyword search without any special syntax.
function parseSearchTerms(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] || m[2] || '').trim();
    if (t) terms.push(t);
  }
  return [...new Set(terms)];
}

// Count non-overlapping occurrences of `needle` in `hay`.
function countOccurrences(hay, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

// Search index cache: reuse the lowercased haystack per note across searches,
// rebuilding an entry only when the note's mtime changes. This keeps repeated
// searches from re-lowercasing every note body on each keystroke.
const _searchCache = new Map(); // path -> { mtimeMs, title, titleLow, kind, hay }

/**
 * Case-insensitive full-text search over title and body.
 * - Multi-keyword: whitespace-separated terms are ANDed (all must appear).
 * - Phrases: wrap in "double quotes" to match a term containing spaces.
 * - Ranked: title hits and more frequent matches score higher.
 * @returns {Promise<Array<{ path, title, kind, snippet, score }>>}
 */
export async function searchNotes(query) {
  const terms = parseSearchTerms(query);
  if (!terms.length) return [];

  const notes = await getAllNotes();
  const alive = new Set(notes.map((n) => n.path));
  for (const k of _searchCache.keys()) if (!alive.has(k)) _searchCache.delete(k);

  const hits = [];
  for (const note of notes) {
    const {
      path: p, data, content, mtimeMs,
    } = note;
    const abs = resolveNotePath(p);
    const generation = _noteReadGenerations.get(note) ?? pathGeneration(abs);
    let e = _searchCache.get(p);
    if (!e || e.mtimeMs !== mtimeMs || e.generation !== generation) {
      const title = (data.title || p).toString();
      const kind = contentKind(data);
      const metadata = [
        data.url,
        data.canonicalUrl,
        data.domain,
        data.description,
        data.summary,
        ...(Array.isArray(data.tags) ? data.tags : [data.tags]),
        data.sourceUrl,
        data.sourceDomain,
        data.siteName,
        data.author,
      ].filter((value) => typeof value === 'string').join('\n');
      e = {
        mtimeMs,
        generation,
        title,
        kind,
        titleLow: title.toLowerCase(),
        hay: `${title}\n${metadata}\n${content}`.toLowerCase(),
      };
      if (pathGeneration(abs) === generation) _searchCache.set(p, e);
    }

    // Every term must be present (AND). Score = total occurrences, with a
    // boost for terms found in the title. Track the earliest hit for the snippet.
    let matchesAll = true;
    let score = 0;
    let firstIdx = Infinity;
    for (const t of terms) {
      const idx = e.hay.indexOf(t);
      if (idx === -1) { matchesAll = false; break; }
      if (idx < firstIdx) firstIdx = idx;
      score += countOccurrences(e.hay, t);
      if (e.titleLow.includes(t)) score += 10;
    }
    if (!matchesAll) continue;

    const start = Math.max(0, firstIdx - 40);
    const snippet = e.hay.slice(start, firstIdx + 80).replace(/\s+/g, ' ').trim();
    hits.push({
      path: p, title: e.title, kind: e.kind, snippet, score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits;
}
