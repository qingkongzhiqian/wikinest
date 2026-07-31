import { describe, expect, it } from 'vitest';
// @ts-ignore The web host remains plain JavaScript.
import { canRefreshSyncedNote, refreshSyncedNote } from '../../src/web/page.js';

describe('external synced-note refresh', () => {
  it('reloads only a clean editor with a newer version and restores scroll', async () => {
    const calls: string[] = [];
    const snapshot = {
      current: 'notes/a.md',
      documentState: {
        path: 'notes/a.md',
        version: 'old-version',
        status: 'saved',
        revision: 4,
      },
    };

    await refreshSyncedNote({
      loadIndex: async () => calls.push('index'),
      getSnapshot: () => snapshot,
      fetchNote: async () => ({
        path: 'notes/a.md',
        content: 'remote',
        version: 'new-version',
      }),
      getScrollY: () => 324,
      restoreScroll: (scrollY: number) => calls.push(`scroll:${scrollY}`),
      openNote: async (path: string, guard: () => boolean, note: { version: string }) => {
        expect(path).toBe('notes/a.md');
        expect(note.version).toBe('new-version');
        expect(guard()).toBe(true);
        calls.push('open');
        return true;
      },
    });

    expect(calls).toEqual(['index', 'open', 'scroll:324']);
  });

  it.each(['dirty', 'saving', 'error', 'conflict'])(
    'detects but never reloads an externally changed %s editor',
    async (status) => {
      const opened: string[] = [];
      const snapshot = {
        current: 'notes/a.md',
        documentState: {
          path: 'notes/a.md',
          version: 'old-version',
          status,
          revision: 4,
        },
      };

      await refreshSyncedNote({
        loadIndex: async () => {},
        getSnapshot: () => snapshot,
        fetchNote: async () => ({
          path: 'notes/a.md',
          content: 'remote',
          version: 'new-version',
        }),
        onExternalChange: () => opened.push('external-change'),
        openNote: async () => opened.push('open'),
      });

      expect(opened).toEqual(['external-change']);
    },
  );

  it('does not reload a clean editor when the external version is unchanged', async () => {
    const opened: string[] = [];
    const snapshot = {
      current: 'notes/a.md',
      documentState: {
        path: 'notes/a.md',
        version: 'same-version',
        status: 'saved',
        revision: 4,
      },
    };

    await refreshSyncedNote({
      loadIndex: async () => {},
      getSnapshot: () => snapshot,
      fetchNote: async () => ({ path: 'notes/a.md', version: 'same-version' }),
      openNote: async () => opened.push('open'),
    });

    expect(opened).toEqual([]);
  });

  it('accepts only the saved unified document state', () => {
    expect(canRefreshSyncedNote({
      current: 'notes/a.md',
      documentState: {
        path: 'notes/a.md',
        version: 'v1',
        status: 'saved',
        revision: 0,
      },
    })).toBe(true);
    expect(canRefreshSyncedNote({
      current: 'notes/a.md',
      documentState: {
        path: 'notes/a.md',
        version: 'v1',
        status: 'dirty',
        revision: 0,
      },
    })).toBe(false);
  });
});
