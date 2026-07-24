import { describe, expect, it } from 'vitest';
import {
  isSafeLinkUrl,
  isSafeUploadUrl,
} from '../src/editor/safe-url';

describe('safe URL policy', () => {
  it('allows HTTP, HTTPS, mailto, hash and canonical internal note links', () => {
    for (const value of [
      'https://example.test/notes/a',
      'http://example.test/image.png',
      'mailto:person@example.test',
      '#section-1',
      'notes/a.md',
      'assets/image.png',
    ]) {
      expect(isSafeLinkUrl(value)).toBe(true);
    }
  });

  it('rejects executable schemes and browser-decodable obfuscation', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java%73cript:alert(1)',
      'javascript%3Aalert(1)',
      ' data:text/html,boom',
      'file:///private/secret',
      'vbscript:msgbox(1)',
      'java\nscript:alert(1)',
      'java%0ascript:alert(1)',
    ]) {
      expect(isSafeLinkUrl(value)).toBe(false);
    }
  });

  it('rejects non-canonical relative paths and unsafe upload URLs', () => {
    for (const value of [
      '../secret.md',
      './notes/a.md',
      'notes//a.md',
      '/absolute.md',
      '//example.test/resource',
      'notes\\a.md',
      'data:image/png;base64,AA==',
      'blob:https://example.test/id',
      'https://example.test/\nsecret',
    ]) {
      expect(isSafeUploadUrl(value)).toBe(false);
    }
    expect(isSafeUploadUrl('https://cdn.example.test/image.png')).toBe(true);
    expect(isSafeUploadUrl('uploads/image.png')).toBe(true);
  });
});
