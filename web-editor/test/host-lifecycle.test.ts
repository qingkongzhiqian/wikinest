import { describe, expect, it } from 'vitest';
import { createEditorClient } from '../src/main';

describe('editor host lifecycle defaults', () => {
  it('creates the bundled HTTP client when mount has no host client', async () => {
    const client = createEditorClient();
    expect(typeof client.saveNote).toBe('function');
    expect(typeof client.uploadImage).toBe('function');
  });
});
