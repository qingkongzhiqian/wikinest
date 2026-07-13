// Desktop settings <-> environment bridge.
//
// The web/CLI/Docker builds read configuration from a .env file, but a packaged
// desktop app has no .env. Instead we persist the same keys via electron-store
// and inject them into process.env before the backend server starts. Keeping the
// key names identical to the env vars means src/core/* needs zero changes.

// Every configurable env var the desktop settings UI manages. Grouped only for
// readability; storage is a flat { KEY: value } object under the "settings" key.
export const SETTING_KEYS = [
  // LLM (auto-classify / tidy / synthesize / RAG answer)
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  // Embedding (semantic search / ask); falls back to LLM_* when blank
  'EMBED_BASE_URL', 'EMBED_API_KEY', 'EMBED_MODEL',
  // Image object storage (S3-compatible)
  'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL',
  'S3_ENDPOINT', 'S3_REGION', 'S3_KEY_PREFIX', 'S3_FORCE_PATH_STYLE',
];

/** Read persisted settings as a complete { KEY: string } map (missing → ''). */
export function readSettings(store) {
  const saved = store.get('settings') || {};
  const out = {};
  for (const k of SETTING_KEYS) {
    out[k] = typeof saved[k] === 'string' ? saved[k] : '';
  }
  return out;
}

/** Persist settings, keeping only known keys with non-empty trimmed values. */
export function writeSettings(store, data) {
  const clean = {};
  for (const k of SETTING_KEYS) {
    const v = data && typeof data[k] === 'string' ? data[k].trim() : '';
    if (v) clean[k] = v;
  }
  store.set('settings', clean);
  return clean;
}

/** Inject non-empty settings into process.env (call before importing server). */
export function applySettingsToEnv(settings = {}) {
  for (const k of SETTING_KEYS) {
    const v = settings[k];
    if (typeof v === 'string' && v) process.env[k] = v;
  }
}

/**
 * Live-sync every managed key into process.env: set non-empty values and DELETE
 * cleared ones. Unlike applySettingsToEnv (startup, additive), this makes a
 * removed/blank field actually take effect at runtime, so the desktop app can
 * hot-apply LLM / Embedding / S3 changes without restarting.
 * WIKI_CONTENT_DIR is intentionally not managed here (vault switch restarts).
 */
export function syncSettingsToEnv(settings = {}) {
  for (const k of SETTING_KEYS) {
    const v = settings && typeof settings[k] === 'string' ? settings[k].trim() : '';
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
}
