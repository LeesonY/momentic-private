import React, { useState } from 'react';
import type { AuthProfile, Environment } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { validatedEnvironmentInput } from '../../pages/environmentInput.ts';

type TlsPolicy = Environment['tlsPolicy'];

/**
 * Create or edit one test environment. Test ids keep the old inline forms'
 * names: `environment-*` when creating, `edit-environment-*` when editing.
 */
export const EnvironmentDialog: React.FC<{
  projectId: string;
  /** Absent: create a new environment. */
  environment?: Environment;
  authProfiles: AuthProfile[];
  onClose: () => void;
  onSaved: (environment: Environment) => void;
}> = ({ projectId, environment, authProfiles, onClose, onSaved }) => {
  const editing = Boolean(environment);
  const ids = editing ? 'edit-environment' : 'environment';
  const formId = editing ? 'edit-environment-form' : 'create-environment-form';
  const [name, setName] = useState(environment?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(environment?.baseUrl ?? '');
  const [origins, setOrigins] = useState(
    environment?.allowedOrigins.join('\n') ?? '',
  );
  const [excludedPaths, setExcludedPaths] = useState(
    environment?.excludedPaths.join('\n') ?? '',
  );
  const [tlsPolicy, setTlsPolicy] = useState<TlsPolicy>(
    environment?.tlsPolicy ?? 'strict',
  );
  const [defaultAuthId, setDefaultAuthId] = useState(
    environment?.defaultAuthProfileId ?? '',
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isHttpEnvironment = (() => {
    try {
      return new URL(baseUrl.trim()).protocol === 'http:';
    } catch {
      return false;
    }
  })();

  const close = () => {
    if (!saving) onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const input = validatedEnvironmentInput(
        name,
        baseUrl,
        origins,
        excludedPaths,
        tlsPolicy,
      );
      if (!environment) {
        onSaved(await defaultApiClient.createEnvironment(projectId, input));
        return;
      }
      const updated = await defaultApiClient.updateEnvironment(environment.id, {
        expectedVersion: environment.version,
        ...input,
        defaultAuthProfileId: defaultAuthId || null,
      });
      if (updated.projectId !== projectId || updated.id !== environment.id)
        throw new Error('服务器返回的环境标识与当前项目不一致');
      onSaved(updated);
    } catch (err) {
      const sessionExpired =
        err instanceof Error &&
        ((err as Error & { status?: number }).status === 401 ||
          (err as Error & { code?: string }).code === 'UNAUTHENTICATED');
      setError(
        sessionExpired
          ? '登录状态已失效，请在新标签页重新登录 DCP 后回到本表单重试，已填写内容会保留。'
          : err instanceof Error
            ? err.message
            : editing
              ? '保存环境失败，请刷新版本后重试'
              : '创建环境失败',
      );
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑测试环境' : '新建测试环境'}
      description={
        editing
          ? '保存时会校验版本，避免覆盖他人的修改。'
          : '环境决定运行可以访问的范围、要避开的路径和证书校验方式。'
      }
      size="lg"
      onClose={close}
      closeOnOverlay={false}
      testId={editing ? 'edit-environment-dialog' : 'create-environment-dialog'}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            onClick={close}
            data-testid={editing ? 'btn-cancel-edit-environment' : undefined}
          >
            取消
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            data-testid={
              editing ? 'btn-save-environment' : 'btn-create-environment'
            }
            disabled={
              saving ||
              !name.trim() ||
              !baseUrl.trim()
            }
          >
            {saving
              ? editing
                ? '保存中…'
                : '创建中…'
              : editing
                ? '保存修改'
                : '创建环境'}
          </button>
        </>
      }
    >
      <form
        id={formId}
        data-testid={formId}
        className="lqa-model-form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="环境名称" required htmlFor={`${ids}-name`}>
          <input
            id={`${ids}-name`}
            data-testid={`${ids}-name`}
            className="form-input"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            disabled={saving}
            placeholder="例如：预发布测试环境"
          />
        </Field>
        <Field label="TLS 证书校验" htmlFor={`${ids}-tls`}>
          <select
            id={`${ids}-tls`}
            data-testid={`${ids}-tls`}
            className="form-select"
            value={tlsPolicy}
            disabled={saving}
            onChange={(event) => setTlsPolicy(event.target.value as TlsPolicy)}
          >
            <option value="strict">严格验证证书（推荐）</option>
            <option value="allow_self_signed">
              允许自签名证书（仅受控测试环境）
            </option>
          </select>
        </Field>
        {isHttpEnvironment ? (
          <p className="text-sm muted is-wide" role="status">
            HTTP 地址没有 TLS 证书。即使选择“允许自签名证书”，本表单也会保留你的选择，
            但创建成功后服务端仍以严格模式保存；如果实际站点是 HTTPS，请填写 HTTPS 基准 URL。
          </p>
        ) : tlsPolicy === 'allow_self_signed' ? (
          <p className="text-sm muted is-wide" role="status">
            注意：允许自签名证书将放宽此测试环境浏览器上下文的 HTTPS 证书错误校验。
            仅适用于受控测试环境和单一获准 HTTPS Origin；请勿用于不可信网站。
          </p>
        ) : null}
        <Field
          label="基准 URL"
          required
          hint="保留路径与参数，运行默认从这里开始。"
          htmlFor={`${ids}-base-url`}
          className="is-wide"
        >
          <input
            id={`${ids}-base-url`}
            data-testid={`${ids}-base-url`}
            className="form-input"
            type="url"
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              // Preserve the user's TLS selection across URL edits and
              // failed submissions. The final HTTP effective mode is safely
              // normalized by validatedEnvironmentInput.
              if (editing || origins.trim()) return;
              try {
                const url = new URL(event.target.value);
                if (['http:', 'https:'].includes(url.protocol))
                  setOrigins(url.origin);
              } catch {
                /* Wait until the URL is complete. */
              }
            }}
            required
            disabled={saving}
            placeholder="https://staging.example.com/login?lang=zh"
          />
        </Field>
        <Field
          label="允许访问的 Origins"
          hint={editing ? '每行一个。' : '每行一个；填写基准 URL 后自动带出。'}
          htmlFor={`${ids}-origins`}
        >
          <textarea
            id={`${ids}-origins`}
            data-testid={`${ids}-origins`}
            className="form-textarea is-mono"
            rows={3}
            value={origins}
            onChange={(event) => setOrigins(event.target.value)}
            disabled={saving}
            placeholder="https://staging.example.com"
          />
        </Field>
        <Field
          label="排除路径"
          hint="每行一个，运行时不会访问这些危险页面。"
          htmlFor={`${ids}-excluded`}
        >
          <textarea
            id={`${ids}-excluded`}
            data-testid={`${ids}-excluded`}
            className="form-textarea is-mono"
            rows={3}
            value={excludedPaths}
            onChange={(event) => setExcludedPaths(event.target.value)}
            disabled={saving}
            placeholder={'/admin/delete\n/checkout/payment'}
          />
        </Field>
        {environment && (
          <Field
            label="默认登录凭据"
            hint="在此环境开始测试时默认使用；只能选此环境下有效的凭据。"
            htmlFor="edit-environment-default-auth"
            className="is-wide"
          >
            <select
              id="edit-environment-default-auth"
              data-testid="edit-environment-default-auth"
              className="form-select"
              value={defaultAuthId}
              onChange={(event) => setDefaultAuthId(event.target.value)}
              disabled={saving}
            >
              <option value="">无（匿名访问）</option>
              {authProfiles
                .filter(
                  (profile) =>
                    profile.environmentId === environment.id &&
                    profile.status === 'active',
                )
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {error && (
          <Alert
            tone="danger"
            role="alert"
            className="is-wide"
            testId={
              editing ? 'edit-environment-error' : 'environment-create-error'
            }
          >
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
