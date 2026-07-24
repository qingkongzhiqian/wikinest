const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f]/;
const RELATIVE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=@%-]*$/;

function decodedUrl(value: string): string | undefined {
  if (!value || CONTROL_OR_WHITESPACE.test(value) || value !== value.trim()) return undefined;

  let decoded = value;
  try {
    for (let round = 0; round < 4; round += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return undefined;
  }
  return CONTROL_OR_WHITESPACE.test(decoded) ? undefined : decoded;
}

function isCanonicalRelativePath(value: string): boolean {
  if (
    !value
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || value.includes('?')
    || value.includes('#')
  ) return false;
  return value.split('/').every((segment) => RELATIVE_SEGMENT.test(segment));
}

function isAllowedAbsoluteUrl(value: string, protocols: string[]): boolean {
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function isSafeLinkUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const decoded = decodedUrl(value);
  if (!decoded) return false;
  if (decoded.startsWith('#')) return decoded.length > 1;
  if (decoded.toLowerCase().startsWith('mailto:')) {
    return decoded.slice('mailto:'.length).length > 0;
  }
  return isAllowedAbsoluteUrl(decoded, ['http:', 'https:']) || isCanonicalRelativePath(decoded);
}

export function isSafeUploadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const decoded = decodedUrl(value);
  if (!decoded) return false;
  return isAllowedAbsoluteUrl(decoded, ['http:', 'https:']) || isCanonicalRelativePath(decoded);
}
