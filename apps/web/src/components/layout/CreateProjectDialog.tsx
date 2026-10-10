import React, { useState } from 'react';
import { useApp } from '../../state/AppContext.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';

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
    <Modal
      title="创建项目"
      description="创建后可以配置环境、项目知识和模型，再通过 URL 发起冒烟测试。"
      onClose={onClose}
      closeOnOverlay={!saving}
      testId="create-project-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="submit"
            form="create-project-form"
            className="btn btn-primary"
            disabled={saving || !name.trim()}
          >
            {saving ? '创建中…' : '创建并进入项目'}
          </button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={submit}>
        <Field label="项目名称" required htmlFor="new-project-name">
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
        </Field>
        {error && (
          <Alert tone="danger" role="alert" testId="create-project-error">
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
