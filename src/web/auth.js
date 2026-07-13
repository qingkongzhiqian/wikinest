import crypto from 'node:crypto';

// Constant-time string comparison to avoid leaking length/content via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getMcpToken() { return process.env.WIKI_TOKEN || ''; }
export function getWebPassword() { return process.env.WIKI_PASSWORD || ''; }
export function getWebUser() { return process.env.WIKI_USER || 'wiki'; }

// ---------------------------------------------------------------------------
// Session cookie (signed, stateless). Replaces the ugly native Basic-auth
// browser prompt with a proper login page. The cookie is an HMAC-signed token
// so no server-side session store is needed.
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'wiki_session';

function sessionSecret() {
  // Derive from the password by default so changing the password invalidates
  // all existing sessions. Override with WIKI_SESSION_SECRET if desired.
  return process.env.WIKI_SESSION_SECRET || getWebPassword() || getMcpToken() || 'wikinest';
}

function sessionTtlMs() {
  const h = Number(process.env.WIKI_SESSION_TTL_HOURS) || 168; // default 7 days
  return h * 3600000;
}

function sign(data) {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url');
}

export function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + sessionTtlMs() })).toString('base64url');
  return payload + '.' + sign(payload);
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function readSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

export function setSessionCookie(req, res, user) {
  const token = createSession(user);
  const secure = req.secure || (req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
  const maxAge = Math.floor(sessionTtlMs() / 1000);
  const parts = [COOKIE_NAME + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAge];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/** Validate a username/password pair against the configured credentials. */
export function checkCredentials(user, pass) {
  const p = getWebPassword();
  if (!p) return true; // no password configured -> open
  // Single-user login: the username is optional; default to the configured user.
  const u = user || getWebUser();
  return safeEqual(u, getWebUser()) && safeEqual(pass || '', p);
}

/**
 * Bearer-token auth for the MCP HTTP endpoint.
 * When WIKI_TOKEN is unset the endpoint is left open (local dev); startup logs
 * a loud warning so you don't accidentally expose a public-writable MCP.
 */
export function mcpBearer(req, res, next) {
  const token = getMcpToken();
  if (!token) return next();
  const h = req.get('authorization') || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (safeEqual(bearer, token)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// HTTP Basic auth header check - kept for curl/API/script compatibility.
function checkBasicHeader(req) {
  const h = req.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const idx = decoded.indexOf(':');
  const user = idx === -1 ? decoded : decoded.slice(0, idx);
  const pw = idx === -1 ? '' : decoded.slice(idx + 1);
  return safeEqual(user, getWebUser()) && safeEqual(pw, getWebPassword());
}

/**
 * Web UI + REST API guard. Accepts a valid session cookie OR a Basic-auth
 * header (for scripts). Unauthenticated browser requests are redirected to the
 * login page; API requests get a 401 JSON so the frontend can react.
 */
export function webGuard(req, res, next) {
  if (!getWebPassword()) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  if (readSession(req)) return next();
  if (checkBasicHeader(req)) return next();

  const wantsJson = req.path.startsWith('/api/')
    || req.xhr
    || (req.get('accept') || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'unauthorized' });

  const dest = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(302, '/login?next=' + dest);
}
