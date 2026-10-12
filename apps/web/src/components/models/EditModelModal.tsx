import React, { useState } from 'react';
import type { ModelProfile, ModelProfilePatch } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKENS_RANGE_ERROR,
  adapterLabels,
  parseOutputTokens,
} from './modelForm.ts';

/**
 * Admin-only: renames a profile or changes its output cap. Connection fields
 * stay read-only here because editing them would not reset probe results.
 */
export const EditModelModal: React.FC<{
  model: ModelProfile;
  onClose: () => void;
  onSaved: (model: ModelProfile) => void;
}> = ({ model, onClose, onSaved }) => {
  const [name, setName] = useState(model.name);
  const [outputTokens, setOutputTokens] = useState(
    model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameChanged = name.trim() !== model.name;
  const capChanged =
    outputTokens.trim() !==
    (model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || (!nameChanged && !capChanged)) return;
    const patch: ModelProfilePatch = { expectedVersion: model.version };
    if (nameChanged) patch.name = name.trim();
    if (capChanged) {
      const cap = parseOutputTokens(outputTokens);
      if (cap === null) {
        setError(OUTPUT_TOKENS_RANGE_ERROR);
        return;
      }
      patch.maxOutputTokens = cap;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await defaultApiClient.updateModel(model.id, patch));
    } catch (reason) {
      const code =
        reason && typeof reason === 'object' && 'code' in reason
          ? reason.code
          : undefined;
      setError(
        code === 'VERSION_CONFLICT'
          ? '模型配置已被其他操作更新，请刷新页面后重试'
          : reason instanceof Error
            ? `保存失败：${reason.message}`
            : '保存失败，请稍后重试',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="编辑模型"
      onClose={onClose}
      closeOnOverlay={!saving}
      testId={`edit-model-dialog-${model.id}`}
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
            form="form-edit-model"
            className="btn btn-primary"
            disabled={saving || !name.trim() || (!nameChanged && !capChanged)}
            data-testid="btn-edit-model-submit"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="form-edit-model" onSubmit={(e) => void submit(e)}>
        <dl className="kv lqa-model-edit-summary">
          <dt>接口协议</dt>
          <dd>{adapterLabels[model.adapter]}</dd>
          <dt>服务地址</dt>
          <dd>
            <code>{model.endpoint}</code>
          </dd>
          <dt>模型 ID</dt>
          <dd>
            <code>{model.configuredModelId}</code>
          </dd>
        </dl>
        <Field label="名称" required htmlFor="edit-model-name">
          <input
            id="edit-model-name"
            className="form-input"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="单次输出上限（token）"
          htmlFor="edit-model-cap"
          hint={`范围 ${MIN_OUTPUT_TOKENS}–${MAX_OUTPUT_TOKENS}；先思考再作答的模型需要更大的值`}
        >
          <input
            id="edit-model-cap"
            className="form-input"
            type="number"
            min={MIN_OUTPUT_TOKENS}
            max={MAX_OUTPUT_TOKENS}
            step={1}
            placeholder={`默认 ${DEFAULT_OUTPUT_TOKENS}`}
            value={outputTokens}
            data-testid="edit-model-max-output-tokens"
            onChange={(e) => setOutputTokens(e.target.value)}
          />
        </Field>
        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
