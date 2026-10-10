import React, { useState } from 'react';
import { useApp } from '../../state/AppContext.tsx';

/** Server-authoritative project creation; never fabricates local IDs. */
export const CreateProjectDialog: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  const { createProject } = useApp();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await createProject(name);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建项目失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.5)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-title"
        className="card"
        style={{ width: '100%', maxWidth: 460, padding: 24 }}
        data-testid="create-project-dialog"
      >
        <h2 id="create-project-title" style={{ marginTop: 0 }}>
          创建项目
        </h2>
        <p style={{ color: 'var(--color-text-muted)' }}>
          创建后可配置环境、项目知识和模型，再通过 URL 发起冒烟测试。
        </p>
        <form onSubmit={submit}>
          <label className="form-label" htmlFor="new-project-name">
            项目名称
          </label>
          <input
            id="new-project-name"
            className="form-input"
            data-testid="new-project-name"
            autoFocus
            required
            maxLength={120}
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：电商后台测试"
          />
          {error && (
            <p
              role="alert"
              data-testid="create-project-error"
              style={{ color: 'var(--color-danger)' }}
            >
              {error}
            </p>
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 12,
              marginTop: 24,
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !name.trim()}
            >
              {saving ? '创建中…' : '创建并进入项目'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
