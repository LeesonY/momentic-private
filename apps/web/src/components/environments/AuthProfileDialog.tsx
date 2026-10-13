import React, { useState } from 'react';
import type {
  AuthProfile,
  AuthProfileCreate,
  AuthVariable,
  Criterion,
  Environment,
} from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

type AuthModeChoice = AuthProfile['mode'];

interface AgentVariableDraft {
  name: string;
  value: string;
  sensitive: boolean;
  note: string;
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEFAULT_AGENT_INSTRUCTIONS =
  '打开登录页，用户名填 QA_USERNAME，密码填 QA_PASSWORD，然后点击登录。';
const defaultAgentVariables = (): AgentVariableDraft[] => [
  { name: 'QA_USERNAME', value: '', sensitive: false, note: '登录账号' },
  { name: 'QA_PASSWORD', value: '', sensitive: true, note: '登录密码' },
];
const FORM_ID = 'create-auth-profile-form';

/**
 * Add a sign-in credential to one environment. Secret values are write-only:
 * they go to the API once and are never shown again.
 */
export const AuthProfileDialog: React.FC<{
  projectId: string;
  environment: Environment;
  onClose: () => void;
  /** `environment` is set when the new credential became its default. */
  onCreated: (
    profile: AuthProfile,
    environment: Environment | null,
    notice?: string,
  ) => void;
}> = ({ projectId, environment, onClose, onCreated }) => {
  const [authName, setAuthName] = useState('');
  const [authMode, setAuthMode] = useState<AuthModeChoice>('agent');
  const [agentLoginUrl, setAgentLoginUrl] = useState('');
  const [agentInstructions, setAgentInstructions] = useState(
    DEFAULT_AGENT_INSTRUCTIONS,
  );
  const [agentVariables, setAgentVariables] = useState<AgentVariableDraft[]>(
    defaultAgentVariables,
  );
  const [secretVal, setSecretVal] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authOrigins, setAuthOrigins] = useState(
    environment.allowedOrigins.join('\n'),
  );
  const [authLoginUrl, setAuthLoginUrl] = useState('');
  const [authDetectionMode, setAuthDetectionMode] = useState<'ai' | 'manual'>(
    'ai',
  );
  const [authUsernameCss, setAuthUsernameCss] = useState(
    'input[name="username"]',
  );
  const [authPasswordCss, setAuthPasswordCss] = useState(
    'input[type="password"]',
  );
  const [authSubmitCss, setAuthSubmitCss] = useState('button[type="submit"]');
  const [authSuccessBy, setAuthSuccessBy] = useState<'test_id' | 'text'>(
    'test_id',
  );
  const [authSuccessTestId, setAuthSuccessTestId] = useState('');
  const [authError, setAuthError] = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => {
    if (!saving) onClose();
  };

  /** Agent sign-in input: names and notes in agentConfig, values write-only. */
  const agentProfileInput = (): Pick<
    AuthProfileCreate,
    'agentConfig' | 'secretInput'
  > => {
    const variables = agentVariables.map((variable) => ({
      ...variable,
      name: variable.name.trim(),
      note: variable.note.trim(),
    }));
    const names = variables.map((variable) => variable.name);
    if (
      !agentInstructions.trim() ||
      variables.length === 0 ||
      new Set(names).size !== names.length ||
      variables.some(
        (variable) => !VARIABLE_NAME.test(variable.name) || !variable.value,
      )
    )
      throw new Error('MISSING_AUTH_MATERIAL');
    const declared = variables.map((variable): AuthVariable => ({
      name: variable.name,
      sensitive: variable.sensitive,
      ...(variable.note ? { note: variable.note } : {}),
    })) as [AuthVariable, ...AuthVariable[]];
    return {
      agentConfig: {
        ...(agentLoginUrl.trim() ? { loginUrl: agentLoginUrl.trim() } : {}),
        instructions: agentInstructions.trim(),
        variables: declared,
      },
      secretInput: Object.fromEntries(
        variables.map((variable) => [variable.name, variable.value]),
      ),
    };
  };

  const updateAgentVariable = (
    index: number,
    change: Partial<AgentVariableDraft>,
  ) =>
    setAgentVariables((old) =>
      old.map((variable, i) =>
        i === index ? { ...variable, ...change } : variable,
      ),
    );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setAuthError('');
    let created: AuthProfile;
    try {
      const origins = authOrigins
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const url = new URL(item);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            !environment.allowedOrigins.includes(url.origin)
          )
            throw new Error('INVALID_AUTH_ORIGIN');
          return url.origin;
        });
      // Agent sign-in and AI-recognized forms find success themselves.
      const needsSuccessMarker =
        authMode === 'storage_state' ||
        (authMode === 'form' && authDetectionMode === 'manual');
      if (!origins.length || (needsSuccessMarker && !authSuccessTestId.trim()))
        throw new Error('MISSING_AUTH_CONFIGURATION');
      const successCriterion: Criterion = {
        id: 'login_success',
        kind: 'element_visible',
        description: '用户配置的登录成功标识可见',
        sourceKind: 'user_spec',
        sourceRef: 'auth_profile',
        locator: { by: authSuccessBy, value: authSuccessTestId.trim() },
      };
      const config: AuthProfileCreate = {
        name: authName.trim() || `${environment.name} 登录`.slice(0, 120),
        mode: authMode,
        environmentId: environment.id,
        allowedOrigins: [origins[0]!, ...new Set(origins.slice(1))],
        sharingPolicy: 'exclusive_run',
        ...(authMode === 'form'
          ? {
              formConfig: {
                loginUrl: authLoginUrl.trim(),
                detectionMode: authDetectionMode,
                ...(authDetectionMode === 'manual'
                  ? {
                      usernameTarget: {
                        by: 'css' as const,
                        value: authUsernameCss.trim(),
                      },
                      passwordTarget: {
                        by: 'css' as const,
                        value: authPasswordCss.trim(),
                      },
                      submitTarget: {
                        by: 'css' as const,
                        value: authSubmitCss.trim(),
                      },
                      successCriterion,
                    }
                  : {}),
              },
              secretInput: { username: authUsername, password: secretVal },
            }
          : authMode === 'storage_state'
            ? {
                storageCriterion: successCriterion,
                secretInput: { storageState: secretVal },
              }
            : authMode === 'agent'
              ? agentProfileInput()
              : {}),
      };
      if (
        ((authMode === 'form' || authMode === 'storage_state') && !secretVal) ||
        (authMode === 'form' &&
          (!authUsername ||
            !authLoginUrl.trim() ||
            (authDetectionMode === 'manual' &&
              (!authUsernameCss.trim() ||
                !authPasswordCss.trim() ||
                !authSubmitCss.trim()))))
      )
        throw new Error('MISSING_AUTH_MATERIAL');
      created = await defaultApiClient.createAuthProfile(projectId, config);
    } catch {
      // Never echo request bodies or server diagnostics: these fields contain
      // passwords and storage-state JSON.
      setAuthError(
        authMode === 'agent'
          ? '保存失败。请检查允许访问的域名、登录说明和变量：变量名用大写字母开头，只含大写字母、数字和下划线，不能重复，值不能为空。'
          : '保存失败。请检查登录地址、账号密码与允许访问的域名。',
      );
      setSaving(false);
      return;
    }
    // The first credential becomes the environment default, so starting a
    // test in this environment actually uses the newly saved login.
    if (authMode === 'none' || environment.defaultAuthProfileId) {
      onCreated(created, null);
      return;
    }
    try {
      const updated = await defaultApiClient.updateEnvironment(environment.id, {
        expectedVersion: environment.version,
        defaultAuthProfileId: created.id,
      });
      onCreated(created, updated);
    } catch {
      onCreated(
        created,
        null,
        '凭据已保存，设为环境默认登录失败。请编辑环境，选择该凭据作为默认登录。',
      );
    }
  };

  return (
    <Modal
      title="添加登录凭据"
      description={
        <>
          环境：{environment.name}
          <span className="lqa-env-dialog-url">{environment.baseUrl}</span>
        </>
      }
      size="lg"
      onClose={close}
      closeOnOverlay={false}
      testId="create-auth-profile-dialog"
      footer={
        <>
          <span className="modal-footer-note">
            <AppIcon name="lock" size={12} /> 只写入，保存后不可查看
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            onClick={close}
          >
            取消
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="btn btn-primary"
            data-testid="btn-create-auth-profile"
            disabled={saving}
          >
            <AppIcon name="lock" size={14} />
            {saving ? '正在保存…' : '加密保存凭据'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="lqa-model-form-grid"
        onSubmit={(event) => void submit(event)}
      >
        <Field
          label="凭据名称"
          optional
          hint="留空时使用“环境名称 登录”"
          htmlFor="auth-profile-name"
        >
          <input
            id="auth-profile-name"
            type="text"
            className="form-input"
            data-testid="auth-profile-name"
            placeholder="例如：财务管理员测试账号"
            value={authName}
            onChange={(e) => setAuthName(e.target.value)}
            maxLength={120}
          />
        </Field>
        <Field label="认证方式" htmlFor="auth-profile-mode">
          <select
            id="auth-profile-mode"
            className="form-select"
            data-testid="auth-profile-mode"
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as AuthModeChoice)}
          >
            <option value="agent">AI 登录（按登录说明操作，推荐）</option>
            <option value="form">账号密码登录（AI 自动识别）</option>
            <option value="storage_state">复用登录会话（storageState）</option>
            <option value="none">不使用认证</option>
          </select>
        </Field>

        {authMode === 'agent' ? (
          <>
            <p className="field-hint is-wide lqa-auth-note">
              AI 按登录说明自己完成登录，和 Momentic Mo
              的用法一致。模型只看到变量名和备注，看不到变量值；敏感变量的值在截图、页面快照和日志里打码。
            </p>
            <Field
              label="登录页 URL"
              optional
              hint="不填时从运行的目标地址开始。"
              htmlFor="agent-login-url"
              className="is-wide"
            >
              <input
                id="agent-login-url"
                className="form-input"
                type="url"
                data-testid="agent-login-url"
                value={agentLoginUrl}
                onChange={(e) => setAgentLoginUrl(e.target.value)}
                placeholder="https://app.example.com/login"
              />
            </Field>
            <div className="field is-wide">
              <span className="field-label">变量</span>
              <div className="lqa-auth-vars" role="group" aria-label="变量">
                <div className="lqa-auth-var is-head" aria-hidden="true">
                  <span>变量名</span>
                  <span>值</span>
                  <span>备注</span>
                  <span>敏感</span>
                  <span />
                </div>
                {agentVariables.map((variable, index) => (
                  <div
                    className="lqa-auth-var"
                    key={index}
                    data-testid={`agent-variable-${index}`}
                  >
                    <input
                      className="form-input is-mono"
                      aria-label="变量名"
                      value={variable.name}
                      onChange={(e) =>
                        updateAgentVariable(index, {
                          name: e.target.value.toUpperCase(),
                        })
                      }
                      placeholder="QA_PASSWORD"
                      required
                    />
                    <input
                      className="form-input"
                      aria-label={`${variable.name || '变量'} 的值`}
                      type={variable.sensitive ? 'password' : 'text'}
                      autoComplete={variable.sensitive ? 'new-password' : 'off'}
                      value={variable.value}
                      onChange={(e) =>
                        updateAgentVariable(index, { value: e.target.value })
                      }
                      placeholder="只写入，不回显"
                      required
                    />
                    <input
                      className="form-input"
                      aria-label="备注"
                      value={variable.note}
                      onChange={(e) =>
                        updateAgentVariable(index, { note: e.target.value })
                      }
                      placeholder="例如：财务管理员账号"
                      maxLength={200}
                    />
                    <label className="check lqa-auth-var-sensitive">
                      <input
                        type="checkbox"
                        checked={variable.sensitive}
                        onChange={(e) =>
                          updateAgentVariable(index, {
                            sensitive: e.target.checked,
                          })
                        }
                      />
                      <span className="lqa-auth-var-sensitive-label">敏感</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      aria-label={`删除变量 ${variable.name}`}
                      title="删除变量"
                      disabled={agentVariables.length <= 1}
                      onClick={() =>
                        setAgentVariables((old) =>
                          old.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <AppIcon name="trash" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm lqa-auth-var-add"
                  data-testid="agent-variable-add"
                  disabled={agentVariables.length >= 20}
                  onClick={() =>
                    setAgentVariables((old) => [
                      ...old,
                      { name: '', value: '', sensitive: false, note: '' },
                    ])
                  }
                >
                  <AppIcon name="plus" size={14} />
                  添加变量
                </button>
              </div>
            </div>
            <Field
              label="登录说明"
              required
              hint="用自然语言写登录步骤，引用变量名，不要写变量值。"
              htmlFor="agent-instructions"
              className="is-wide"
            >
              <textarea
                id="agent-instructions"
                className="form-textarea"
                data-testid="agent-instructions"
                rows={3}
                maxLength={4000}
                value={agentInstructions}
                onChange={(e) => setAgentInstructions(e.target.value)}
                required
              />
            </Field>
          </>
        ) : authMode === 'form' ? (
          <>
            <Field
              label="登录页 URL"
              required
              htmlFor="auth-login-url"
              className="is-wide"
            >
              <input
                id="auth-login-url"
                className="form-input"
                type="url"
                value={authLoginUrl}
                onChange={(e) => setAuthLoginUrl(e.target.value)}
                required
              />
            </Field>
            <Field label="登录用户名" required htmlFor="auth-username">
              <input
                id="auth-username"
                className="form-input"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
                required
              />
            </Field>
            <Field
              label="登录密码"
              required
              hint="只写入，保存后不可查看"
              htmlFor="auth-password"
            >
              <input
                id="auth-password"
                className="form-input"
                type="password"
                autoComplete="new-password"
                value={secretVal}
                onChange={(e) => setSecretVal(e.target.value)}
                required
              />
            </Field>
            {authDetectionMode === 'ai' && (
              <p
                className="field-hint is-wide lqa-auth-note"
                data-testid="auth-ai-guidance"
              >
                AI
                自动识别登录表单与登录成功标识；遇到验证码时会提示补充。保存后可在该环境开始测试。
              </p>
            )}
            <details className="disclosure is-wide">
              <summary>高级设置（可选）</summary>
              <div className="disclosure-body">
                <Field label="表单识别方式" htmlFor="auth-detection-mode">
                  <select
                    id="auth-detection-mode"
                    data-testid="auth-detection-mode"
                    className="form-select"
                    value={authDetectionMode}
                    onChange={(e) =>
                      setAuthDetectionMode(e.target.value as 'ai' | 'manual')
                    }
                  >
                    <option value="ai">AI 自动识别</option>
                    <option value="manual">使用固定定位配置</option>
                  </select>
                </Field>
                {authDetectionMode === 'manual' && (
                  <>
                    <div className="section-label">登录表单定位器（CSS）</div>
                    <div className="lqa-auth-locators">
                      {(
                        [
                          ['用户名输入框', authUsernameCss, setAuthUsernameCss],
                          ['密码输入框', authPasswordCss, setAuthPasswordCss],
                          ['提交按钮', authSubmitCss, setAuthSubmitCss],
                        ] as const
                      ).map(([label, value, setter]) => (
                        <Field label={label} key={label}>
                          <input
                            className="form-input is-mono"
                            value={value}
                            onChange={(e) => setter(e.target.value)}
                            required
                          />
                        </Field>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </details>
          </>
        ) : authMode === 'storage_state' ? (
          <Field
            label="Playwright storageState JSON"
            required
            hint="只写入，保存后不可查看"
            htmlFor="auth-storage-state"
            className="is-wide"
          >
            <textarea
              id="auth-storage-state"
              className="form-textarea is-mono"
              rows={4}
              value={secretVal}
              onChange={(e) => setSecretVal(e.target.value)}
              placeholder='{"cookies":[],"origins":[]}'
              required
            />
          </Field>
        ) : (
          <p className="field-hint is-wide lqa-auth-note">
            此凭据不保存任何密钥，仅用于明确标识匿名访问。
          </p>
        )}

        {(authMode === 'storage_state' ||
          (authMode === 'form' && authDetectionMode === 'manual')) && (
          <Field
            label="登录成功标识"
            required
            hint="用于判断登录是否真正成功，不以 Cookie 存在代替。"
            htmlFor="auth-success-value"
            className="is-wide"
          >
            <div className="lqa-auth-success">
              <select
                className="form-select"
                aria-label="登录成功标识类型"
                value={authSuccessBy}
                onChange={(e) =>
                  setAuthSuccessBy(e.target.value as 'test_id' | 'text')
                }
              >
                <option value="test_id">data-testid 属性</option>
                <option value="text">页面可见文本（精确匹配）</option>
              </select>
              <input
                id="auth-success-value"
                className="form-input"
                value={authSuccessTestId}
                onChange={(e) => setAuthSuccessTestId(e.target.value)}
                placeholder={
                  authSuccessBy === 'test_id'
                    ? 'dashboard-user-menu'
                    : '退出登录'
                }
                required
              />
            </div>
          </Field>
        )}

        <Field
          label="允许访问的 Origins"
          required
          hint="每行一个，已按环境带出。须同时包含登录域名和业务域名，且不能超出环境范围。"
          htmlFor="auth-profile-origins"
          className="is-wide"
        >
          <textarea
            id="auth-profile-origins"
            className="form-textarea is-mono"
            data-testid="auth-profile-origins"
            rows={2}
            value={authOrigins}
            onChange={(e) => setAuthOrigins(e.target.value)}
            placeholder="https://app.example.com"
            required
          />
        </Field>

        {authError && (
          <Alert tone="danger" role="alert" className="is-wide">
            {authError}
          </Alert>
        )}
      </form>
    </Modal>
  );
};
