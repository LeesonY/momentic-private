import React, { useEffect, useRef, useState } from 'react';
import type {
  ModelProfile,
  ModelProfileCreate,
  ModelProbeResult,
} from '@localqa/contracts';
import { defaultApiClient } from '../api/index.ts';
import { useAppContext } from '../state/AppContext.tsx';
import { Page } from '../components/layout/Page.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';

const probeFailureHints: Record<string, string> = {
  MODEL_NOT_CONFIGURED:
    '模型服务可能拒绝了认证（401/403），也可能缺少密钥或协议配置不匹配。请核对 API Key、接口协议与服务地址。',
  MODEL_BILLING_REQUIRED:
    '上游服务提示计费或余额异常，请检查服务商账号余额和模型权限。',
  RATE_LIMITED: '服务商触发限流，请稍后重试。',
  MODEL_TIMEOUT: '模型调用超时，请检查服务端响应时间和网络连接。',
  VALIDATION_ERROR:
    '请求被服务商拒绝，可能是模型 ID、请求格式或 API 协议不兼容。',
  MODEL_OUTPUT_TRUNCATED:
    '模型响应达到输出上限，思考过程也可能占用额度。请检查探测输出预算与服务商限制。',
  SERVICE_UNAVAILABLE:
    '服务暂时不可用，可能是上游异常、网络连接或响应格式问题。',
};

export const ModelsPage: React.FC = () => {
  const { currentUser, currentProject, replaceProject } = useAppContext();
  const activeProjectIdRef = useRef(currentProject?.id);
  activeProjectIdRef.current = currentProject?.id;
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [grantedModels, setGrantedModels] = useState<ModelProfile[]>([]);
  const [grantChoice, setGrantChoice] = useState('');
  const [defaultChoice, setDefaultChoice] = useState('');
  const [grantSaving, setGrantSaving] = useState(false);
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [projectModelsLoading, setProjectModelsLoading] = useState(false);
  const [projectModelsError, setProjectModelsError] = useState<string | null>(
    null,
  );
  const [probeResults, setProbeResults] = useState<
    Record<string, ModelProbeResult>
  >({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newModel, setNewModel] = useState<ModelProfileCreate>({
    name: '',
    endpoint: '',
    configuredModelId: '',
    adapter: 'anthropic_messages',
    responseFormat: 'json_object',
    dataBoundary: 'external',
    apiKey: '',
  });

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating || currentUser?.globalRole !== 'admin') return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await defaultApiClient.createModel({
        ...newModel,
        name: newModel.name.trim(),
        endpoint: newModel.endpoint.trim(),
        configuredModelId: newModel.configuredModelId.trim(),
      });
      setModels((old) => [...old, created]);
      setNewModel({
        name: '',
        endpoint: '',
        configuredModelId: '',
        adapter: 'anthropic_messages',
        responseFormat: 'json_object',
        dataBoundary: 'external',
        apiKey: '',
      });
      setShowCreate(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建模型失败');
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setModels([]);
      setGrantedModels([]);
      setProjectModelsError(null);
      setProjectModelsLoading(true);
      try {
        const [res, projectRes] = await Promise.all([
          defaultApiClient.listModels({ limit: 100 }),
          currentProject
            ? defaultApiClient.listProjectModels(currentProject.id, {
                limit: 100,
              })
            : Promise.resolve({
                items: [] as ModelProfile[],
                nextCursor: null,
              }),
        ]);
        if (cancelled) return;
        setModels(res.items);
        setGrantedModels(projectRes.items);
      } catch (err) {
        if (!cancelled)
          setProjectModelsError(
            err instanceof Error ? err.message : '读取项目模型失败',
          );
      } finally {
        if (!cancelled) setProjectModelsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);

  useEffect(() => {
    setDefaultChoice(currentProject?.defaultModelProfileId ?? '');
    setGrantChoice('');
  }, [currentProject?.id, currentProject?.defaultModelProfileId]);

  const grantModel = async () => {
    if (
      !currentProject ||
      !grantChoice ||
      grantSaving ||
      currentUser?.globalRole !== 'admin'
    )
      return;
    setGrantSaving(true);
    setProjectModelsError(null);
    try {
      const projectId = currentProject.id;
      const model = await defaultApiClient.grantProjectModel(projectId, {
        modelProfileId: grantChoice,
      });
      if (activeProjectIdRef.current !== projectId) return;
      setGrantedModels((previous) =>
        previous.some((p) => p.id === model.id)
          ? previous
          : [...previous, model],
      );
      setGrantChoice('');
    } catch (err) {
      if (activeProjectIdRef.current === currentProject.id)
        setProjectModelsError(
          err instanceof Error ? err.message : '授权模型失败',
        );
    } finally {
      setGrantSaving(false);
    }
  };

  const saveDefault = async () => {
    if (!currentProject || defaultSaving || currentUser?.globalRole !== 'admin')
      return;
    if (defaultChoice && !grantedModels.some((m) => m.id === defaultChoice)) {
      setProjectModelsError('默认模型必须先获得本项目授权');
      return;
    }
    setDefaultSaving(true);
    setProjectModelsError(null);
    try {
      const updated = await defaultApiClient.updateProject(currentProject.id, {
        expectedVersion: currentProject.version,
        defaultModelProfileId: defaultChoice || null,
      });
      replaceProject(updated);
    } catch (err) {
      if (activeProjectIdRef.current === currentProject.id)
        setProjectModelsError(
          err instanceof Error ? err.message : '设置默认模型失败',
        );
    } finally {
      setDefaultSaving(false);
    }
  };

  const handleProbe = async (modelId: string) => {
    setProbingId(modelId);
    setProbeErrors((previous) => {
      const next = { ...previous };
      delete next[modelId];
      return next;
    });
    setProbeResults((previous) => {
      const next = { ...previous };
      delete next[modelId];
      return next;
    });
    try {
      const res = await defaultApiClient.probeModel(modelId);
      setProbeResults((prev) => ({ ...prev, [modelId]: res }));
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN';
      const hint =
        probeFailureHints[code] ??
        '能力探测未成功完成，请检查 API 响应和模型配置。';
      setProbeErrors((prev) => ({
        ...prev,
        [modelId]: `探测失败（${code}）：${hint} 当前模型状态不会被自动改为禁用。`,
      }));
    } finally {
      setProbingId(null);
    }
  };

  return (
    <Page
      className="lqa-models-page"
      testId="models-page"
      title={
        <>
          模型管理
          <span className="badge badge-neutral">{models.length} 个模型</span>
        </>
      }
      description="统一管理模型接入、能力探测与项目授权，为自动化测试提供可靠的推理能力。"
    >
      <Alert tone="info" title="安全提示">
        访问密钥只用于加密存储，不会在页面回显；外部模型可能接收脱敏后的测试页面信息。
      </Alert>

      {currentProject && (
        <section
          className="card lqa-models-section lqa-models-grants"
          data-testid="project-model-settings"
        >
          <div className="lqa-models-section-heading">
            <span className="lqa-models-section-icon">
              <AppIcon name="shield" size={21} />
            </span>
            <div>
              <h2>项目模型授权</h2>
              <p>当前项目：{currentProject.name} · 仅授权模型可用于运行测试</p>
            </div>
          </div>
          {projectModelsError && (
            <p
              role="alert"
              className="lqa-models-alert"
              data-testid="project-model-error"
            >
              {projectModelsError}
            </p>
          )}
          {projectModelsLoading ? (
            <p>正在读取项目模型…</p>
          ) : (
            <>
              <div
                className="lqa-models-grants-summary"
                data-testid="project-grants-summary"
              >
                <span className="lqa-models-summary-label">已授权模型</span>
                <span
                  className={
                    grantedModels.length
                      ? 'lqa-models-summary-names'
                      : 'lqa-models-summary-empty'
                  }
                >
                  {grantedModels.length > 0
                    ? grantedModels.map((m) => m.name).join('、')
                    : '暂无，请先添加并授权模型'}
                </span>
              </div>
              {currentUser?.globalRole === 'admin' && (
                <div className="lqa-models-control-row">
                  <label className="form-label" htmlFor="grant-model-select">
                    授权新模型
                  </label>
                  <select
                    id="grant-model-select"
                    className="form-select"
                    data-testid="grant-model-select"
                    value={grantChoice}
                    disabled={grantSaving}
                    onChange={(e) => setGrantChoice(e.target.value)}
                  >
                    <option value="">选择全局已有模型</option>
                    {models
                      .filter(
                        (m) =>
                          !grantedModels.some((g) => g.id === m.id) &&
                          m.status !== 'disabled',
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}（{m.status}）
                        </option>
                      ))}
                  </select>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => void grantModel()}
                    disabled={!grantChoice || grantSaving}
                    data-testid="btn-grant-model"
                  >
                    {grantSaving ? '授权中…' : '授权给当前项目'}
                  </button>
                </div>
              )}
              <div className="lqa-models-control-row">
                <label className="form-label" htmlFor="default-model-select">
                  默认模型
                </label>
                <select
                  id="default-model-select"
                  className="form-select"
                  value={defaultChoice}
                  data-testid="default-model-select"
                  disabled={
                    currentUser?.globalRole !== 'admin' || defaultSaving
                  }
                  onChange={(e) => setDefaultChoice(e.target.value)}
                >
                  <option value="">不指定（按授权模型选择）</option>
                  {grantedModels
                    .filter((m) => m.status !== 'disabled')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
                {currentUser?.globalRole === 'admin' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="btn-save-default-model"
                    disabled={
                      defaultSaving ||
                      defaultChoice ===
                        (currentProject.defaultModelProfileId ?? '')
                    }
                    onClick={() => void saveDefault()}
                  >
                    {defaultSaving ? '保存中…' : '保存默认模型'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
      {currentUser?.globalRole === 'admin' && (
        <section
          className="card lqa-models-section lqa-models-create-section"
          data-testid="model-create-section"
        >
          <div className="lqa-models-section-heading lqa-models-create-heading">
            <span className="lqa-models-section-icon">
              <AppIcon name="plus" size={21} />
            </span>
            <div>
              <h2>接入新模型</h2>
              <p>添加模型服务的基础配置，完成能力探测后即可授权给项目。</p>
            </div>
            <button
              type="button"
              className={
                showCreate
                  ? 'btn btn-secondary lqa-models-create-toggle'
                  : 'btn btn-primary lqa-models-create-toggle'
              }
              onClick={() => setShowCreate((open) => !open)}
              aria-expanded={showCreate}
              data-testid="btn-toggle-create-model"
            >
              <AppIcon name={showCreate ? 'close' : 'plus'} size={17} />
              {showCreate ? '收起配置' : '添加模型'}
            </button>
          </div>
          {showCreate && (
            <form
              className="lqa-model-create-form"
              onSubmit={(e) => void handleCreate(e)}
              data-testid="form-create-model"
            >
              <div className="lqa-model-form-grid">
                <label className="lqa-model-field">
                  <span className="form-label">
                    配置名称 <span className="lqa-required">*</span>
                  </span>
                  <input
                    className="form-input"
                    required
                    maxLength={120}
                    placeholder="例如：DeepSeek V3 / Claude Sonnet"
                    value={newModel.name}
                    onChange={(e) =>
                      setNewModel((m) => ({ ...m, name: e.target.value }))
                    }
                  />
                  <span className="lqa-field-hint">
                    用于在平台中识别此模型配置
                  </span>
                </label>
                <label className="lqa-model-field">
                  <span className="form-label">
                    接口协议 <span className="lqa-required">*</span>
                  </span>
                  <select
                    className="form-select"
                    value={newModel.adapter}
                    onChange={(e) =>
                      setNewModel((m) => ({
                        ...m,
                        adapter: e.target
                          .value as ModelProfileCreate['adapter'],
                        responseFormat:
                          e.target.value === 'anthropic_messages'
                            ? 'json_object'
                            : 'json_schema',
                      }))
                    }
                  >
                    <option value="anthropic_messages">
                      Anthropic Messages
                    </option>
                    <option value="openai_compatible">
                      OpenAI Chat Completions
                    </option>
                  </select>
                  <span className="lqa-field-hint">
                    按服务商提供的 API 格式选择
                  </span>
                </label>
                <label className="lqa-model-field lqa-model-field-wide">
                  <span className="form-label">
                    HTTPS 服务地址 <span className="lqa-required">*</span>
                  </span>
                  <input
                    className="form-input"
                    required
                    type="url"
                    pattern="https://.*"
                    placeholder="https://provider.example/v1"
                    value={newModel.endpoint}
                    onChange={(e) =>
                      setNewModel((m) => ({ ...m, endpoint: e.target.value }))
                    }
                  />
                  <span className="lqa-field-hint">
                    仅支持 HTTPS，请填写兼容的 API 基础地址
                  </span>
                </label>
                <label className="lqa-model-field">
                  <span className="form-label">
                    模型标识 (Model ID) <span className="lqa-required">*</span>
                  </span>
                  <input
                    className="form-input"
                    required
                    maxLength={200}
                    placeholder="例如：deepseek-chat"
                    value={newModel.configuredModelId}
                    onChange={(e) =>
                      setNewModel((m) => ({
                        ...m,
                        configuredModelId: e.target.value,
                      }))
                    }
                  />
                  <span className="lqa-field-hint">
                    填写服务商实际使用的模型 ID
                  </span>
                </label>
                <label className="lqa-model-field">
                  <span className="form-label">
                    API Key{' '}
                    <span className="lqa-field-optional">
                      加密保存 · 不回显
                    </span>
                  </span>
                  <input
                    className="form-input"
                    type="password"
                    autoComplete="new-password"
                    placeholder="输入模型服务商提供的 API Key"
                    value={newModel.apiKey ?? ''}
                    onChange={(e) =>
                      setNewModel((m) => ({ ...m, apiKey: e.target.value }))
                    }
                  />
                  <span className="lqa-field-hint">
                    密钥不会在保存后显示于页面
                  </span>
                </label>
              </div>
              <div className="lqa-model-form-note">
                <AppIcon name="shield" size={17} />
                <span>
                  创建后需通过连通性与能力探测，才能授权给项目并参与正式运行。
                </span>
              </div>
              {createError && (
                <p className="lqa-models-alert" role="alert">
                  {createError}
                </p>
              )}
              <div className="lqa-model-form-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCreate(false)}
                  disabled={creating}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={creating}
                  data-testid="btn-create-model-submit"
                >
                  <AppIcon name="check" size={17} />
                  {creating ? '正在安全保存…' : '创建模型'}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <section className="lqa-models-inventory" data-testid="model-inventory">
        <div className="lqa-models-inventory-heading">
          <h2>
            已接入模型 <span>{models.length}</span>
          </h2>
          <p>查看模型状态、API 配置与能力探测结果</p>
        </div>
        <div className="lqa-models-list">
          {models.length === 0 ? (
            <div className="lqa-models-empty" data-testid="models-empty-state">
              <div className="lqa-models-empty-visual">
                <AppIcon name="cpu" size={27} />
              </div>
              <h3>还没有接入 AI 模型</h3>
              <p>
                添加模型并完成能力探测与项目授权后，就可以为真实站点执行自动化测试。离线演示不会代替真实模型。
              </p>
              {currentUser?.globalRole === 'admin' && !showCreate && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setShowCreate(true)}
                  data-testid="models-empty-add"
                >
                  <AppIcon name="plus" size={17} /> 添加第一个模型
                </button>
              )}
            </div>
          ) : (
            models.map((m) => {
              const probe = probeResults[m.id];
              const isInternal = m.dataBoundary === 'internal';
              return (
                <div
                  key={m.id}
                  className="card lqa-model-profile"
                  data-testid={`model-card-${m.id}`}
                >
                  <div className="lqa-model-profile-header">
                    <div className="lqa-model-profile-heading">
                      <span className="lqa-model-profile-icon">
                        <AppIcon name="cpu" size={21} />
                      </span>
                      <h3>{m.name}</h3>
                      <span
                        className={`badge ${isInternal ? 'badge-success' : 'badge-warning'}`}
                      >
                        {isInternal ? '内网本地部署' : '外部云端商业服务'}
                      </span>
                      <span className="badge badge-neutral">
                        适配器: {m.adapter}
                      </span>
                    </div>

                    <div className="lqa-model-profile-actions">
                      {probe && (
                        <span
                          className="badge"
                          style={{
                            backgroundColor:
                              probe.status === 'ready'
                                ? 'var(--color-success-bg)'
                                : probe.status === 'degraded'
                                  ? 'var(--color-warning-bg)'
                                  : 'var(--color-danger-bg)',
                            color:
                              probe.status === 'ready'
                                ? 'var(--color-success-text)'
                                : probe.status === 'degraded'
                                  ? 'var(--color-warning-text)'
                                  : 'var(--color-danger-text)',
                          }}
                        >
                          {probe.status === 'ready'
                            ? '可用 (Ready)'
                            : probe.status === 'degraded'
                              ? '降级 (Degraded)'
                              : '探测失败 (Disabled)'}
                        </span>
                      )}
                      <button
                        className="btn btn-secondary"
                        onClick={() => handleProbe(m.id)}
                        disabled={probingId === m.id}
                        data-testid={`btn-probe-${m.id}`}
                      >
                        {probingId === m.id ? '正在探测…' : '连通性探测'}
                      </button>
                    </div>
                  </div>

                  {probeErrors[m.id] && (
                    <div
                      className="lqa-model-probe-error"
                      role="alert"
                      data-testid={`probe-error-${m.id}`}
                    >
                      <AppIcon name="shield" size={17} />
                      <span>{probeErrors[m.id]}</span>
                    </div>
                  )}

                  <div className="lqa-model-profile-details">
                    <div>
                      <span>模型 ID</span>
                      <code>{m.configuredModelId}</code>
                    </div>
                    <div>
                      <span>服务地址</span>
                      <code>{m.endpoint}</code>
                    </div>
                    <div>
                      <span>运行状态</span>
                      <code>{m.status}</code>
                    </div>
                  </div>

                  {/* Capabilities Badges */}
                  <div className="lqa-model-profile-capabilities">
                    <span
                      className={`badge ${m.capabilities.structuredOutput ? 'badge-info' : 'badge-neutral'}`}
                    >
                      结构化输出 (JSON):{' '}
                      {m.capabilities.structuredOutput ? '支持' : '不支持'}
                    </span>
                    <span
                      className={`badge ${m.capabilities.nativeTools ? 'badge-info' : 'badge-neutral'}`}
                    >
                      原生工具调用 (Tool Call):{' '}
                      {m.capabilities.nativeTools ? '支持' : '不支持'}
                    </span>
                    <span
                      className={`badge ${m.capabilities.imageInput ? 'badge-info' : 'badge-neutral'}`}
                    >
                      视觉截图解析 (Vision):{' '}
                      {m.capabilities.imageInput ? '支持' : '不支持'}
                    </span>
                  </div>

                  {/* Data Notice */}
                  {!isInternal ? (
                    <div className="lqa-model-profile-notice is-external">
                      <AppIcon name="shield" size={17} />
                      <span>
                        外部模型数据提示：Prompt、节点标签及页面截图可能经加密通道发送至外部服务，请确保脱敏策略已生效。
                      </span>
                    </div>
                  ) : (
                    <div className="lqa-model-profile-notice">
                      <AppIcon name="shield" size={17} />
                      <span>
                        内网模型提示：该端点标记为内部服务，仍需检查实际路由、代理、日志和部署策略。
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </Page>
  );
};
