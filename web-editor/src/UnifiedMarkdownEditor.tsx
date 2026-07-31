import { useSyncExternalStore } from 'react';
import type { EditorSaveStatus } from './types';

export interface UnifiedEditorSnapshot {
  path: string;
  status: EditorSaveStatus;
}

export interface UnifiedEditorController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UnifiedEditorSnapshot;
  attachEditorRoot(element: HTMLDivElement | null): void;
  retry(): void;
  openConflict(): void;
}

const STATUS_LABELS: Record<'en' | 'zh-CN', Record<EditorSaveStatus, string>> = {
  en: {
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving',
    error: 'Save failed',
    conflict: 'Conflict detected',
  },
  'zh-CN': {
    saved: '已保存',
    dirty: '有未保存更改',
    saving: '保存中',
    error: '保存失败',
    conflict: '检测到冲突',
  },
};

interface UnifiedMarkdownEditorProps {
  controller: UnifiedEditorController;
  locale: 'en' | 'zh-CN';
}

export function UnifiedMarkdownEditor({ controller, locale }: UnifiedMarkdownEditorProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const needsRecovery = snapshot.status === 'error' || snapshot.status === 'conflict';

  return (
    <div className="wikinest-editor">
      {needsRecovery ? (
        <div className="wikinest-editor__toolbar" role="alert">
          <span className={`wikinest-editor__status is-${snapshot.status}`}>
            {STATUS_LABELS[locale][snapshot.status]}
          </span>
          {snapshot.status === 'error' ? (
            <button type="button" onClick={() => controller.retry()}>
              {locale === 'zh-CN' ? '重试保存' : 'Retry save'}
            </button>
          ) : (
            <button type="button" onClick={() => controller.openConflict()}>
              {locale === 'zh-CN' ? '打开冲突副本' : 'Open conflict copy'}
            </button>
          )}
        </div>
      ) : null}
      <div ref={controller.attachEditorRoot} className="wikinest-editor__content" />
    </div>
  );
}
