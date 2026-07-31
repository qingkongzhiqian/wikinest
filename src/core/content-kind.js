export const CONTENT_KINDS = Object.freeze({
  NOTE: 'note',
  BOOKMARK: 'bookmark',
  WEB_CLIP: 'web_clip',
});

const KNOWN_KINDS = new Set(Object.values(CONTENT_KINDS));

/**
 * Old Vault files predate the `kind` field and remain ordinary notes.
 */
export function contentKind(data) {
  const value = typeof data?.kind === 'string' ? data.kind.trim() : '';
  return KNOWN_KINDS.has(value) ? value : CONTENT_KINDS.NOTE;
}

export function isKnowledgeNote(note) {
  return contentKind(note?.data ?? note) === CONTENT_KINDS.NOTE;
}

export function isWebClip(note) {
  return contentKind(note?.data ?? note) === CONTENT_KINDS.WEB_CLIP;
}
