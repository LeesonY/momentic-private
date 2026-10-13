import React, { useState } from 'react';
import type { ModelProfile, ModelProfileCreate } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { ContextWindowField } from './ContextWindowField.tsx';
import {
  DEFAULT_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKENS_RANGE_ERROR,
  parseOutputTokens,
  parseContextTokens,
  validateContextBudget,
  CONTEXT_TOKENS_RANGE_ERROR,
} from './modelForm.ts';

const emptyModel: ModelProfileCreate = {
  name: '',
  endpoint: '',
  configuredModelId: '',
  adapter: 'anthropic_messages',
  responseFormat: 'json_object',
  dataBoundary: 'external',
  apiKey: '',
};

/** Admin-only: registers a platform-wide model profile. */
export const CreateModelModal: React.FC<{
  onClose: () => void;
  onCreated: (model: ModelProfile) => void;
}> = ({ onClose, onCreated }) => {
  const [draft, setDraft] = useState<ModelProfileCreate>(emptyModel);
  const [outputTokens, setOutputTokens] = useState('');
  const [contextTokens, setContextTokens] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const cap = outputTokens.trim()
      ? parseOutputTokens(outputTokens)
      : undefined;
    if (cap === null) {
      setError(OUTPUT_TOKENS_RANGE_ERROR);
      return;
    }
    const window = contextTokens.trim()
      ? parseContextTokens(contextTokens)
      : undefined;
    if (window === null) {
      setError(CONTEXT_TOKENS_RANGE_ERROR);
      return;
    }
    if (!validateContextBudget(window, cap)) {
      setError('上下文窗口必须大于单次输出上限');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await defaultApiClient.createModel({
        ...draft,
        ...(cap !== undefined ? { maxOutputTokens: cap } : {}),
        ...(window !== undefined ? { contextWindowTokens: window } : {}),
        name: draft.name.trim(),
        endpoint: draft.endpoint.trim(),
        configuredModelId: draft.configuredModelId.trim(),
      });
      onCreated(created);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建模型失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="添加模型"
      description="添加后先做一次探测，确认可用再授权给项目。"
      size="lg"
      onClose={onClose}
      closeOnOverlay={!saving}
      testId="create-model-dialog"
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
            form="form-create-model"
            className="btn btn-primary"
            disabled={saving}
            data-testid="btn-create-model-submit"
          >
            {saving ? '保存中…' : '添加模型'}
          </button>
        </>
      }
    >
      <form
        id="form-create-model"
        className="lqa-model-form-grid"
        onSubmit={(e) => void submit(e)}
        data-testid="form-create-model"
      >
        <Field label="名称" required htmlFor="new-model-name">
          <input
            id="new-model-name"
            className="form-input"
            required
            autoFocus
            maxLength={120}
            placeholder="例如：DeepSeek V3"
            value={draft.name}
            onChange={(e) => setDraft((m) => ({ ...m, name: e.target.value }))}
          />
        </Field>
        <Field label="接口协议" required htmlFor="new-model-adapter">
          <select
            id="new-model-adapter"
            className="form-select"
            value={draft.adapter}
            onChange={(e) =>
              setDraft((m) => ({
                ...m,
                adapter: e.target.value as ModelProfileCreate['adapter'],
                responseFormat:
                  e.target.value === 'anthropic_messages'
                    ? 'json_object'
                    : 'json_schema',
              }))
            }
          >
            <option value="anthropic_messages">Anthropic Messages</option>
            <option value="openai_compatible">OpenAI Chat Completions</option>
          </select>
        </Field>
        <Field
          label="服务地址"
          required
          htmlFor="new-model-endpoint"
          hint="仅支持 HTTPS，填 API 基础地址"
          className="is-wide"
        >
          <input
            id="new-model-endpoint"
            className="form-input is-mono"
            required
            type="url"
            pattern="https://.*"
            placeholder="https://provider.example/v1"
            value={draft.endpoint}
            onChange={(e) =>
              setDraft((m) => ({ ...m, endpoint: e.target.value }))
            }
          />
        </Field>
        <Field label="模型 ID" required htmlFor="new-model-id">
          <input
            id="new-model-id"
            className="form-input is-mono"
            required
            maxLength={200}
            placeholder="例如：deepseek-chat"
            value={draft.configuredModelId}
            onChange={(e) =>
              setDraft((m) => ({ ...m, configuredModelId: e.target.value }))
            }
          />
        </Field>
        <Field
          label="API Key"
          htmlFor="new-model-key"
          hint="加密保存，保存后不再显示"
        >
          <input
            id="new-model-key"
            className="form-input"
            type="password"
            autoComplete="new-password"
            value={draft.apiKey ?? ''}
            onChange={(e) =>
              setDraft((m) => ({ ...m, apiKey: e.target.value }))
            }
          />
        </Field>
        <Field
          label="单次输出上限（token）"
          optional
          htmlFor="new-model-cap"
          hint="先思考再作答的模型需要更大的值"
        >
          <input
            id="new-model-cap"
            className="form-input"
            type="number"
            min={MIN_OUTPUT_TOKENS}
            max={MAX_OUTPUT_TOKENS}
            step={1}
            placeholder={`默认 ${DEFAULT_OUTPUT_TOKENS}`}
            value={outputTokens}
            data-testid="model-max-output-tokens"
            onChange={(e) => setOutputTokens(e.target.value)}
          />
        </Field>
        <ContextWindowField
          id="model-context-window-tokens"
          value={contextTokens}
          onChange={setContextTokens}
          maxOutputTokens={parseOutputTokens(outputTokens) ?? undefined}
          disabled={saving}
        />
        {error && (
          <Alert tone="danger" role="alert" className="is-wide">
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
