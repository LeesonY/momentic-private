import React, { useState } from 'react';
import type { ModelProfile, ModelProfilePatch } from '@localqa/contracts';
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
  adapterLabels,
  parseOutputTokens,
  parseContextTokens,
  validateContextBudget,
  CONTEXT_TOKENS_RANGE_ERROR,
} from './modelForm.ts';

/** Admin-only: updates a profile without reading back its stored credential. */
export const EditModelModal: React.FC<{
  model: ModelProfile;
  onClose: () => void;
  onSaved: (model: ModelProfile) => void;
}> = ({ model, onClose, onSaved }) => {
  const [name, setName] = useState(model.name);
  const [modelId, setModelId] = useState(model.configuredModelId);
  const [adapter, setAdapter] = useState<ModelProfile['adapter']>(model.adapter);
  const [endpoint, setEndpoint] = useState(model.endpoint);
  const [apiKey, setApiKey] = useState('');
  const [outputTokens, setOutputTokens] = useState(
    model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
  );
  const [saving, setSaving] = useState(false);
  const [contextTokens, setContextTokens] = useState(
    model.contextWindowTokens === undefined
      ? ''
      : String(model.contextWindowTokens),
  );
  const [error, setError] = useState<string | null>(null);

  const nameChanged = name.trim() !== model.name;
  const modelIdChanged = modelId.trim() !== model.configuredModelId;
  const adapterChanged = adapter !== model.adapter;
  const endpointChanged = endpoint.trim() !== model.endpoint;
  const keyChanged = apiKey.trim().length > 0;
  const capChanged =
    outputTokens.trim() !==
    (model.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens));
  const contextChanged =
    contextTokens.trim() !==
    (model.contextWindowTokens === undefined
      ? ''
      : String(model.contextWindowTokens));
  const changed =
    nameChanged || modelIdChanged || adapterChanged || endpointChanged || keyChanged || capChanged || contextChanged;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !changed) return;
    if (!modelId.trim()) {
      setError('模型 ID 不能为空');
      return;
    }
    if (endpointChanged && (!/^https?:\/\//i.test(endpoint.trim()) ||
      (/^http:\/\//i.test(endpoint.trim()) && model.dataBoundary !== 'internal'))) {
      setError('请输入合法的 HTTP(S) 接口地址；HTTP 仅允许内网／本地模型。');
      return;
    }
    const patch: ModelProfilePatch = { expectedVersion: model.version };
    if (adapterChanged) patch.adapter = adapter;
    if (endpointChanged) patch.endpoint = endpoint.trim();
    if (nameChanged) patch.name = name.trim();
    if (modelIdChanged) patch.configuredModelId = modelId.trim();
    if (keyChanged) patch.apiKey = apiKey.trim();
    if (capChanged) {
      const cap = parseOutputTokens(outputTokens);
      if (cap === null) {
        setError(OUTPUT_TOKENS_RANGE_ERROR);
        return;
      }
      patch.maxOutputTokens = cap;
    }
    const window = contextTokens.trim()
      ? parseContextTokens(contextTokens)
      : undefined;
    if (window === null) {
      setError(CONTEXT_TOKENS_RANGE_ERROR);
      return;
    }
    if (
      !validateContextBudget(
        window,
        patch.maxOutputTokens ?? model.maxOutputTokens,
      )
    ) {
      setError('上下文窗口必须大于单次输出上限');
      return;
    }
    if (contextChanged) patch.contextWindowTokens = window ?? null;
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
            disabled={saving || !name.trim() || !modelId.trim() || !changed}
            data-testid="btn-edit-model-submit"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id="form-edit-model" onSubmit={(e) => void submit(e)}>
        <Field label="接口协议" required htmlFor="edit-model-adapter">
          <select
            id="edit-model-adapter"
            data-testid="edit-model-adapter"
            className="form-select"
            value={adapter}
            disabled={saving}
            onChange={(e) => setAdapter(e.target.value as ModelProfile['adapter'])}
          >
            <option value="anthropic_messages">{adapterLabels.anthropic_messages}</option>
            <option value="openai_compatible">{adapterLabels.openai_compatible}</option>
          </select>
        </Field>
        <dl className="kv lqa-model-edit-summary">
          <dt>服务部署位置</dt>
          <dd>{model.dataBoundary === 'internal' ? '内网／本地' : '外部'}</dd>
        </dl>
        <Field label="服务地址" required htmlFor="edit-model-endpoint" hint="内网模型可使用 HTTP（如 http://wb-proxy:8788）；外部模型仅支持 HTTPS">
          <input
            id="edit-model-endpoint"
            data-testid="edit-model-endpoint"
            className="form-input is-mono"
            type="url"
            pattern="https?://.*"
            required
            maxLength={8192}
            disabled={saving}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </Field>
        {/^http:\/\//i.test(endpoint.trim()) && (
          <Alert tone="warning" role="alert">HTTP 不加密 API Key、模型输入和输出；请只用于可信内网。</Alert>
        )}
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
        <Field label="模型 ID" required htmlFor="edit-model-id">
          <input
            id="edit-model-id"
            className="form-input is-mono"
            required
            maxLength={200}
            value={modelId}
            disabled={saving}
            data-testid="edit-model-id"
            onChange={(e) => setModelId(e.target.value)}
          />
        </Field>
        <Field
          label="API Key"
          htmlFor="edit-model-key"
          hint="留空保留原 Key；填写新 Key 后替换，加密保存且不回显"
        >
          <input
            id="edit-model-key"
            className="form-input"
            type="password"
            autoComplete="new-password"
            maxLength={1000}
            placeholder="输入新 Key，留空不修改"
            value={apiKey}
            disabled={saving}
            data-testid="edit-model-key"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
        {(modelIdChanged || keyChanged || adapterChanged || endpointChanged) && (
          <Alert tone="info">修改接口协议、模型 ID、服务地址或 Key 后，模型能力将重置为未探测，需要重新探测；原有 Key 留空即保留。</Alert>
        )}
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
        <ContextWindowField
          id="edit-model-context-window-tokens"
          value={contextTokens}
          onChange={setContextTokens}
          maxOutputTokens={parseOutputTokens(outputTokens) ?? undefined}
          disabled={saving}
        />
        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
