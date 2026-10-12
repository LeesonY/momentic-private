import React, { useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '@localqa/contracts';
import { defaultApiClient } from '../api/index.ts';
import { useAppContext } from '../state/AppContext.tsx';
import { Page } from '../components/layout/Page.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { CreateModelModal } from '../components/models/CreateModelModal.tsx';
import { EditModelModal } from '../components/models/EditModelModal.tsx';
import {
  DEFAULT_OUTPUT_TOKENS,
  adapterLabels,
  statusMeta,
} from '../components/models/modelForm.ts';

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

const capabilityLabels: Array<[keyof ModelProfile['capabilities'], string]> = [
  ['structuredOutput', '结构化输出'],
  ['nativeTools', '工具调用'],
  ['imageInput', '截图识别'],
];

const shortEndpoint = (endpoint: string) =>
  endpoint.replace(/^https:\/\//, '').replace(/\/$/, '');

export const ModelsPage: React.FC = () => {
  const { currentUser, currentProject, replaceProject } = useAppContext();
  const isAdmin = currentUser?.globalRole === 'admin';
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
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
  const [probeNotes, setProbeNotes] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<ModelProfile | null>(null);
  const [deleteName, setDeleteName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | null>(null);

  const replaceModel = (updated: ModelProfile) => {
    const swap = (list: ModelProfile[]) =>
      list.map((m) => (m.id === updated.id ? updated : m));
    setModels(swap);
    setGrantedModels(swap);
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
    if (!currentProject || !grantChoice || grantSaving || !isAdmin) return;
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
    if (!currentProject || defaultSaving || !isAdmin) return;
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
    const clear = (previous: Record<string, string>) => {
      const next = { ...previous };
      delete next[modelId];
      return next;
    };
    setProbeErrors(clear);
    setProbeNotes(clear);
    try {
      const res = await defaultApiClient.probeModel(modelId);
      if (res.status === 'degraded' && res.notes.length > 0)
        setProbeNotes((prev) => ({ ...prev, [modelId]: res.notes.join('；') }));
      // A probe records status and capabilities as a new profile version;
      // refetch so later edits send the current expectedVersion.
      try {
        replaceModel(await defaultApiClient.getModel(modelId));
      } catch {
        // The list still shows the previous version; a reload picks it up.
      }
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
        [modelId]: `探测失败（${code}）：${hint} 模型状态保持不变。`,
      }));
    } finally {
      setProbingId(null);
    }
  };

  const closeDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteName('');
    setDeleteError(null);
  };

  const handleDelete = async () => {
    if (
      !deleteTarget ||
      deleting ||
      deleteName !== deleteTarget.name ||
      currentUser?.globalRole !== 'admin'
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await defaultApiClient.deleteModel(deleteTarget.id, {
        expectedVersion: deleteTarget.version,
        confirmName: deleteName,
      });
      setModels((previous) => previous.filter((m) => m.id !== deleteTarget.id));
      setGrantedModels((previous) =>
        previous.filter((m) => m.id !== deleteTarget.id),
      );
      setGrantChoice((previous) =>
        previous === deleteTarget.id ? '' : previous,
      );
      setDefaultChoice((previous) =>
        previous === deleteTarget.id ? '' : previous,
      );
      setDeleteTarget(null);
      setDeleteName('');
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除模型失败');
    } finally {
      setDeleting(false);
    }
  };

  const defaultId = currentProject?.defaultModelProfileId ?? '';
  const grantedIds = new Set(grantedModels.map((m) => m.id));
  const grantable = models.filter(
    (m) => !grantedIds.has(m.id) && m.status !== 'disabled',
  );
  const defaultModel = grantedModels.find((m) => m.id === defaultId);

  return (
    <Page
      className="lqa-models-page"
      testId="models-page"
      title="模型管理"
      description="接入模型、探测能力，再授权给项目使用。"
      actions={
        isAdmin && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
            data-testid="btn-add-model"
          >
            <AppIcon name="plus" size={16} />
            添加模型
          </button>
        )
      }
    >
      {currentProject && (
        <section
          className="card lqa-models-project"
          data-testid="project-model-settings"
        >
          <div className="card-header">
            <div className="card-heading">
              <h2 className="card-title">
                <AppIcon name="folder" size={17} />
                {currentProject.name}
              </h2>
              <p className="card-description">
                只有授权给本项目的模型才能用于运行测试
              </p>
            </div>
          </div>
          {projectModelsError && (
            <Alert
              tone="danger"
              role="alert"
              className="lqa-models-project-error"
              testId="project-model-error"
            >
              {projectModelsError}
            </Alert>
          )}
          {projectModelsLoading ? (
            <p className="lqa-models-muted">正在读取项目模型…</p>
          ) : (
            <div className="lqa-models-project-grid">
              <div className="lqa-models-project-field">
                <span className="lqa-models-project-label">已授权</span>
                <div
                  className="lqa-models-chips"
                  data-testid="project-grants-summary"
                >
                  {grantedModels.length === 0 ? (
                    <span className="lqa-models-muted">
                      暂无，授权后才能运行测试
                    </span>
                  ) : (
                    grantedModels.map((m) => (
                      <span key={m.id} className="lqa-models-chip">
                        {m.name}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div className="lqa-models-project-field">
                {isAdmin ? (
                  <label
                    className="lqa-models-project-label"
                    htmlFor="default-model-select"
                  >
                    默认模型
                  </label>
                ) : (
                  <span className="lqa-models-project-label">默认模型</span>
                )}
                {isAdmin ? (
                  <div className="lqa-models-inline">
                    <select
                      id="default-model-select"
                      className="form-select"
                      value={defaultChoice}
                      data-testid="default-model-select"
                      disabled={defaultSaving}
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
                    <button
                      type="button"
                      className="btn btn-secondary"
                      data-testid="btn-save-default-model"
                      disabled={defaultSaving || defaultChoice === defaultId}
                      onClick={() => void saveDefault()}
                    >
                      {defaultSaving ? '保存中…' : '保存'}
                    </button>
                  </div>
                ) : (
                  <span>
                    {defaultModel?.name ?? '不指定（按授权模型选择）'}
                  </span>
                )}
              </div>

              {isAdmin && grantable.length > 0 && (
                <div className="lqa-models-project-field">
                  <label
                    className="lqa-models-project-label"
                    htmlFor="grant-model-select"
                  >
                    授权模型
                  </label>
                  <div className="lqa-models-inline">
                    <select
                      id="grant-model-select"
                      className="form-select"
                      data-testid="grant-model-select"
                      value={grantChoice}
                      disabled={grantSaving}
                      onChange={(e) => setGrantChoice(e.target.value)}
                    >
                      <option value="">选择要授权的模型</option>
                      {grantable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}（{statusMeta[m.status].label}）
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
                      {grantSaving ? '授权中…' : '授权'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section
        className="card card-flush lqa-models-inventory"
        data-testid="model-inventory"
      >
        <div className="card-header">
          <div className="card-heading">
            <h2 className="card-title">
              全部模型
              <span className="badge badge-neutral badge-sm">
                {models.length}
              </span>
            </h2>
            <p className="card-description">平台级配置，所有项目共用</p>
          </div>
        </div>
        {models.length === 0 ? (
          <div className="lqa-models-empty" data-testid="models-empty-state">
            <EmptyState
              compact
              icon="cpu"
              title="还没有接入模型"
              description="添加模型并完成探测和项目授权后，才能对真实站点运行测试。"
            />
            {isAdmin && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowCreate(true)}
                data-testid="models-empty-add"
              >
                <AppIcon name="plus" size={16} /> 添加第一个模型
              </button>
            )}
          </div>
        ) : (
          <ul className="lqa-models-list">
            {models.map((m) => {
              const status = statusMeta[m.status];
              const isExternal = m.dataBoundary === 'external';
              const probed = m.status === 'ready' || m.status === 'degraded';
              return (
                <li
                  key={m.id}
                  className="lqa-model-row"
                  data-testid={`model-card-${m.id}`}
                >
                  <div className="lqa-model-main">
                    <div className="lqa-model-title">
                      <span className="cell-title">{m.name}</span>
                      <span
                        className={`badge badge-sm ${isExternal ? 'badge-warning' : 'badge-success'}`}
                        title={
                          isExternal
                            ? '外部服务：脱敏后的页面内容和截图会发送给该服务'
                            : '标记为内网服务：仍需确认实际路由、代理和日志策略'
                        }
                      >
                        {isExternal ? '外部服务' : '内网'}
                      </span>
                      {m.id === defaultId ? (
                        <span className="badge badge-primary badge-sm">
                          本项目默认
                        </span>
                      ) : grantedIds.has(m.id) ? (
                        <span className="badge badge-neutral badge-sm">
                          本项目已授权
                        </span>
                      ) : null}
                    </div>
                    <div className="lqa-model-meta">
                      <code>{m.configuredModelId}</code>
                      <span aria-hidden="true">·</span>
                      <span title={m.endpoint}>
                        {shortEndpoint(m.endpoint)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{adapterLabels[m.adapter]}</span>
                    </div>
                    <div className="lqa-model-meta">
                      {probed ? (
                        <span className="lqa-model-caps">
                          {capabilityLabels.map(([key, label]) => (
                            <span
                              key={key}
                              className={
                                m.capabilities[key] ? 'is-on' : 'is-off'
                              }
                            >
                              <AppIcon
                                name={m.capabilities[key] ? 'check' : 'close'}
                                size={12}
                              />
                              {label}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span>能力待探测</span>
                      )}
                      <span aria-hidden="true">·</span>
                      <span data-testid={`model-output-cap-${m.id}`}>
                        输出上限{' '}
                        {m.maxOutputTokens ??
                          `${DEFAULT_OUTPUT_TOKENS}（默认）`}
                      </span>
                    </div>
                  </div>

                  <div className="lqa-model-side">
                    <span className={`badge badge-dot ${status.className}`}>
                      {probingId === m.id ? '探测中…' : status.label}
                    </span>
                    {isAdmin && (
                      <div className="lqa-model-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleProbe(m.id)}
                          disabled={
                            probingId !== null ||
                            deleteTarget !== null ||
                            m.status === 'disabled'
                          }
                          data-testid={`btn-probe-${m.id}`}
                        >
                          <AppIcon name="activity" size={14} />
                          探测
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-icon"
                          disabled={probingId !== null || deleteTarget !== null}
                          onClick={() => setEditing(m)}
                          aria-label={`编辑 ${m.name}`}
                          title="编辑"
                          data-testid={`btn-edit-model-${m.id}`}
                        >
                          <AppIcon name="edit" size={15} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger-outline btn-sm"
                          disabled={
                            probingId !== null ||
                            deleting ||
                            grantSaving ||
                            defaultSaving
                          }
                          onClick={() => {
                            setDeleteTarget(m);
                            setDeleteName('');
                            setDeleteError(null);
                          }}
                          data-testid={`btn-delete-model-${m.id}`}
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>

                  {probeErrors[m.id] && (
                    <Alert
                      tone="danger"
                      role="alert"
                      className="lqa-model-row-note"
                      testId={`probe-error-${m.id}`}
                    >
                      {probeErrors[m.id]}
                    </Alert>
                  )}
                  {probeNotes[m.id] && (
                    <Alert tone="warning" className="lqa-model-row-note">
                      {probeNotes[m.id]}
                    </Alert>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="lqa-models-footnote">
        <AppIcon name="lock" size={14} />
        API Key
        加密保存，保存后不再显示。标为「外部服务」的模型会收到脱敏后的页面内容和截图。
      </p>

      {showCreate && (
        <CreateModelModal
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setModels((old) => [...old, created]);
            setShowCreate(false);
          }}
        />
      )}
      {editing && (
        <EditModelModal
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            replaceModel(updated);
            setProbeErrors((previous) => {
              const next = { ...previous };
              delete next[updated.id];
              return next;
            });
            setProbeNotes((previous) => {
              const next = { ...previous };
              delete next[updated.id];
              return next;
            });
            setEditing(null);
          }}
        />
      )}
      {deleteTarget && (
        <Modal
          title="删除模型"
          onClose={closeDelete}
          closeOnOverlay={!deleting}
          testId="model-delete-dialog"
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deleting}
                onClick={closeDelete}
                data-testid="model-delete-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleting || deleteName !== deleteTarget.name}
                onClick={() => void handleDelete()}
                data-testid="model-delete-confirm"
              >
                {deleting ? '正在删除…' : '确认删除'}
              </button>
            </>
          }
        >
          <p>
            删除「{deleteTarget.name}
            」后，该模型将从模型列表和新任务的可选项中移除，历史测试记录保留。此操作无法撤销。
          </p>
          <p>
            若该模型仍是项目默认模型，或被未结束的任务、启用的定时计划引用，请先解除引用。
          </p>
          <label className="lqa-model-field">
            <span>输入模型名称「{deleteTarget.name}」以确认</span>
            <input
              className="form-input"
              value={deleteName}
              disabled={deleting}
              autoFocus
              onChange={(event) => setDeleteName(event.target.value)}
              data-testid="model-delete-name"
            />
          </label>
          {deleteError && (
            <Alert tone="danger" title="删除失败" testId="model-delete-error">
              {deleteError}
            </Alert>
          )}
        </Modal>
      )}
    </Page>
  );
};
