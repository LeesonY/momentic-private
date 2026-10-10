import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { CreateProjectDialog } from '../components/layout/CreateProjectDialog.tsx';
import type {
  Environment,
  AuthProfile,
  ModelProfile,
} from '@localqa/contracts';

function configuredDefaultAuth(
  env: Environment | undefined,
  profiles: AuthProfile[],
): string {
  if (!env?.defaultAuthProfileId) return '';
  const profile = profiles.find((item) => item.id === env.defaultAuthProfileId);
  const approvedOrigins = new Set(
    env.allowedOrigins.map((origin) => new URL(origin).origin),
  );
  if (
    !profile ||
    profile.status !== 'active' ||
    profile.environmentId !== env.id ||
    profile.allowedOrigins.some(
      (origin) => !approvedOrigins.has(new URL(origin).origin),
    )
  )
    return '';
  return profile.id;
}

export const ProjectHomePage: React.FC = () => {
  const { currentProject, currentUser, isMock, setRoute } = useApp();
  const [creatingProject, setCreatingProject] = useState(false);

  const [targetUrl, setTargetUrl] = useState('');
  const [description, setDescription] = useState('');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [selectedAuthId, setSelectedAuthId] = useState<string>('');
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Advanced Budget Overrides
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxCases, setMaxCases] = useState(8);
  const [maxPages, setMaxPages] = useState(6);
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxActiveSeconds, setMaxActiveSeconds] = useState(600);
  const [maxActions, setMaxActions] = useState(120);
  const [maxModelCalls] = useState(100);
  const [maxReproductions] = useState(3);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTargetUrl('');
    setSelectedEnvId('');
    setSelectedAuthId('');
    setEnvironments([]);
    setAuthProfiles([]);
    setModels([]);
    setSelectedModelId('');
    setOptionsError(null);
    if (!currentProject) return;
    let cancelled = false;
    const projId = currentProject.id;
    async function loadOptions() {
      setOptionsLoading(true);
      try {
        const [envRes, authRes, modelRes] = await Promise.all([
          defaultApiClient.listEnvironments(projId),
          defaultApiClient.listAuthProfiles(projId),
          defaultApiClient.listProjectModels(projId, { limit: 100 }),
        ]);
        if (cancelled) return;
        setEnvironments(envRes.items);
        if (envRes.items.length > 0) {
          setSelectedEnvId(envRes.items[0].id);
          setTargetUrl(envRes.items[0].baseUrl);
          setSelectedAuthId(
            configuredDefaultAuth(envRes.items[0], authRes.items),
          );
        }

        setAuthProfiles(authRes.items);
        setModels(modelRes.items);
      } catch (err) {
        if (!cancelled)
          setOptionsError(
            err instanceof Error ? err.message : '加载项目配置失败',
          );
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    }
    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, [currentProject]);

  const projectDefaultModel = models.find(
    (m) => m.id === currentProject?.defaultModelProfileId,
  );
  const missingModel = !isMock && !models.some((m) => m.status !== 'disabled');

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProject || currentProject.status !== 'active') {
      setError('请先选择或创建一个未归档的项目');
      return;
    }
    if (optionsLoading || optionsError || missingModel) {
      setError('模型或项目配置尚未就绪，请先完成配置后再运行');
      return;
    }
    if (!targetUrl.trim()) {
      setError('请输入有效的被测目标 URL');
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const run = await defaultApiClient.createRun({
        projectId: currentProject.id,
        targetUrl,
        description: description || undefined,
        environmentId: selectedEnvId || undefined,
        authProfileId: selectedAuthId || undefined,
        modelProfileId: selectedModelId || undefined,
        budgetOverrides: {
          maxCases,
          maxPages,
          maxDepth,
          maxActiveSeconds,
          maxActions,
          maxModelCalls,
          maxReproductions,
        },
      });

      // Jump to workbench with runId
      setRoute('workbench', { runId: run.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动运行失败');
    } finally {
      setStarting(false);
    }
  };

  if (!currentProject) {
    return (
      <div className="lqa-empty-workspace" data-testid="no-project-empty-state">
        <div className="lqa-empty-hero">
          <div>
            <div className="lqa-eyebrow">
              <AppIcon name="sparkles" size={16} />
              AUTOMATED QUALITY WORKSPACE
            </div>
            <h1>让每一次测试，都更有把握。</h1>
            <p>
              将站点探索、测试执行、缺陷复现和证据报告汇集在一个工作空间。
              从创建第一个项目开始，建立可追踪的自动化质量流程。
            </p>
            <div className="lqa-hero-actions">
              {currentUser?.globalRole === 'admin' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setCreatingProject(true)}
                  data-testid="empty-create-project"
                >
                  <AppIcon name="plus" size={18} />
                  创建第一个项目
                  <AppIcon name="arrow-right" size={17} />
                </button>
              ) : (
                <span className="lqa-hero-note">
                  尚未获得项目访问权限，请联系平台管理员。
                </span>
              )}
              {currentUser?.globalRole === 'admin' && (
                <span className="lqa-hero-note">
                  大约需要 1 分钟即可开始配置
                </span>
              )}
            </div>
          </div>
          <div className="lqa-hero-visual" aria-hidden="true">
            <div className="lqa-visual-halo" />
            <div className="lqa-visual-window">
              <AppIcon name="globe" size={33} />
              <div className="lqa-window-line" />
              <div className="lqa-window-line" />
              <div className="lqa-window-line" />
            </div>
            <div className="lqa-visual-check">
              <AppIcon name="check" size={30} />
            </div>
          </div>
        </div>
        <h2 className="lqa-onboarding-heading">
          三个步骤，构建你的自动化测试流程
        </h2>
        <div className="lqa-onboarding-grid">
          <div className="lqa-step-card">
            <div className="lqa-step-icon">
              <AppIcon name="folder" size={21} />
            </div>
            <div>
              <span className="lqa-step-index">STEP 01</span>
              <h3>创建测试项目</h3>
              <p>集中管理目标站点、成员权限与自动化测试任务。</p>
            </div>
          </div>
          <div className="lqa-step-card">
            <div className="lqa-step-icon">
              <AppIcon name="shield" size={21} />
            </div>
            <div>
              <span className="lqa-step-index">STEP 02</span>
              <h3>配置环境与模型</h3>
              <p>设置测试站点、认证方式和项目可使用的 AI 模型。</p>
            </div>
          </div>
          <div className="lqa-step-card">
            <div className="lqa-step-icon">
              <AppIcon name="activity" size={21} />
            </div>
            <div>
              <span className="lqa-step-index">STEP 03</span>
              <h3>发起测试并查看报告</h3>
              <p>通过运行工作台查看执行过程、结果与缺陷证据。</p>
            </div>
          </div>
        </div>
        {creatingProject && (
          <CreateProjectDialog onClose={() => setCreatingProject(false)} />
        )}
      </div>
    );
  }

  return (
    <div
      className="lqa-project-home"
      style={{ maxWidth: '980px', margin: '0 auto' }}
      data-testid="project-home-page"
    >
      <div className="lqa-page-intro">
        <span className="lqa-eyebrow">
          <AppIcon name="sparkles" size={15} /> 自动化测试控制台
        </span>
        <h1
          style={{
            color: 'var(--color-text-main)',
          }}
        >
          {currentProject?.name || '项目首页'}
        </h1>
        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--color-text-muted)',
            marginTop: '4px',
          }}
        >
          输入目标 URL，全自动探索生成用例、执行检查与复现缺陷。
        </p>
      </div>

      {error && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: 'var(--color-danger-bg)',
            color: 'var(--color-danger-text)',
            border: '1px solid var(--color-danger-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: '0.875rem',
            marginBottom: '20px',
          }}
          data-testid="home-error-banner"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleStart} className="card lqa-run-form">
        <div className="lqa-run-form-title">
          <AppIcon name="globe" size={23} />
          <div>
            <h2>启动新的测试任务</h2>
            <p>填写目标地址并检查环境、认证和模型配置。</p>
          </div>
        </div>
        {/* URL Input */}
        <div className="form-group" style={{ marginBottom: '20px' }}>
          <label
            className="form-label"
            style={{ fontSize: '1rem', fontWeight: 600 }}
          >
            被测站点目标地址 (Target URL){' '}
            <span style={{ color: 'var(--color-danger)' }}>*</span>
          </label>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="url"
              className="form-input"
              style={{ fontSize: '1rem', padding: '10px 14px' }}
              placeholder="https://example.com/ 或 http://localhost:8080/"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              required
              data-testid="input-target-url"
            />
          </div>
          <span className="form-help">
            输入获准访问的 HTTP(S) 地址。默认将自动以其 Origin
            作为临时探测范围。
          </span>
        </div>

        {/* Optional Description */}
        <div className="form-group">
          <label className="form-label">本次冒烟测试说明 (可选)</label>
          <input
            type="text"
            className="form-input"
            placeholder="例如: 验证 v2.4 优惠券满减与导航页面交互..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="input-run-description"
          />
        </div>

        {/* Selectors Grid: Environment, Auth, Model */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '16px',
            margin: '20px 0',
          }}
        >
          <div className="form-group">
            <label className="form-label">运行环境 (Environment)</label>
            <select
              className="form-select"
              value={selectedEnvId}
              onChange={(e) => {
                setSelectedEnvId(e.target.value);
                const env = environments.find(
                  (item) => item.id === e.target.value,
                );
                setSelectedAuthId(configuredDefaultAuth(env, authProfiles));
                if (env) setTargetUrl(env.baseUrl);
              }}
              data-testid="select-environment"
            >
              <option value="">不指定环境</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.baseUrl})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">认证凭据配置 (Auth Profile)</label>
            <select
              className="form-select"
              value={selectedAuthId}
              onChange={(e) => setSelectedAuthId(e.target.value)}
              data-testid="select-auth-profile"
            >
              <option value="">不使用认证 (匿名访问)</option>
              {authProfiles
                .filter(
                  (a) =>
                    a.status === 'active' &&
                    (!a.environmentId || a.environmentId === selectedEnvId),
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.mode})
                  </option>
                ))}
            </select>
            {!!selectedAuthId &&
              environments.find((env) => env.id === selectedEnvId)
                ?.defaultAuthProfileId === selectedAuthId && (
                <p data-testid="default-auth-notice" className="form-help">
                  已选择环境默认认证；可手动切换为匿名访问。
                </p>
              )}
          </div>

          <div className="form-group">
            <label htmlFor="select-model-profile" className="form-label">
              本次运行模型
            </label>
            <select
              id="select-model-profile"
              className="form-select"
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              data-testid="select-model-profile"
            >
              <option value="">使用项目默认或授权模型</option>
              {models
                .filter((m) => m.status !== 'disabled')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} (
                    {m.dataBoundary === 'external' ? '外部服务' : '内部服务'})
                  </option>
                ))}
            </select>
            <p data-testid="configured-model-notice" className="form-help">
              {projectDefaultModel
                ? `项目默认：${projectDefaultModel.name}`
                : '未设置项目默认模型时，服务端将从授权模型中选择。'}{' '}
              手动选择时，服务器会校验该模型是否已授权给本项目。
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setRoute('models')}
            >
              查看模型配置
            </button>
          </div>
        </div>

        {/* Model Unconfigured / Blocked Notice */}
        {!isMock && (optionsLoading || optionsError || missingModel) && (
          <div
            style={{
              backgroundColor: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 16px',
              margin: '16px 0',
              fontSize: '0.85rem',
              color: 'var(--color-warning-text)',
            }}
            data-testid="model-unconfigured-notice"
          >
            <strong>【尚不能启动真实模型冒烟】</strong>{' '}
            {optionsLoading
              ? '正在加载项目配置…'
              : optionsError
                ? `配置读取失败：${optionsError}`
                : '当前没有可用模型。请由管理员在“模型管理”中完成配置与项目授权，系统不会自动使用模拟模型。'}
          </div>
        )}

        {/* External Model Data Destination Notice */}
        {!isMock &&
          (selectedModelId
            ? models.find((m) => m.id === selectedModelId)?.dataBoundary ===
              'external'
            : models.some((m) => m.dataBoundary === 'external')) && (
            <div
              style={{
                backgroundColor: 'var(--color-warning-bg)',
                border: '1px solid var(--color-warning-border)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 16px',
                margin: '16px 0',
                fontSize: '0.85rem',
                color: 'var(--color-warning-text)',
              }}
              data-testid="external-model-notice"
            >
              <strong>【外部模型数据去向提示】</strong>
              已配置的模型中包含外部商业服务。若本次运行绑定外部模型， 脱敏后的
              DOM、可访问名称及获准截图可能传输到相应服务商。
              请在项目模型配置中确认实际绑定的数据去向。
            </div>
          )}

        {/* Collapsible Advanced Budget Overrides */}
        <div
          style={{
            marginTop: '16px',
            borderTop: '1px solid var(--color-border-subtle)',
            paddingTop: '16px',
          }}
        >
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowAdvanced(!showAdvanced)}
            data-testid="btn-toggle-advanced-budget"
          >
            {showAdvanced
              ? '收起高级额度与策略配置 ▲'
              : '展开高级额度与策略配置 (Smoke 预设) ▼'}
          </button>

          {showAdvanced && (
            <div
              style={{
                marginTop: '16px',
                padding: '16px',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
              data-testid="advanced-budget-panel"
            >
              <h4
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  marginBottom: '12px',
                }}
              >
                Smoke 额度与安全性策略 (统一预设约束)
              </h4>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '14px',
                }}
              >
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    最多规划用例数 (maxCases: 1-30)
                  </label>
                  <input
                    type="number"
                    className="form-input"
                    value={maxCases}
                    min={1}
                    max={30}
                    onChange={(e) => setMaxCases(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    最多探索页面数 (maxPages: 1-30)
                  </label>
                  <input
                    type="number"
                    className="form-input"
                    value={maxPages}
                    min={1}
                    max={30}
                    onChange={(e) => setMaxPages(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    探索深度限制 (maxDepth: 0-5)
                  </label>
                  <input
                    type="number"
                    className="form-input"
                    value={maxDepth}
                    min={0}
                    max={5}
                    onChange={(e) => setMaxDepth(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    最长执行秒数 (maxActiveSeconds: 60-3600)
                  </label>
                  <input
                    type="number"
                    className="form-input"
                    value={maxActiveSeconds}
                    min={60}
                    max={3600}
                    onChange={(e) =>
                      setMaxActiveSeconds(Number(e.target.value))
                    }
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    最多操作步数 (maxActions)
                  </label>
                  <input
                    type="number"
                    className="form-input"
                    value={maxActions}
                    min={10}
                    max={1000}
                    onChange={(e) => setMaxActions(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="form-label" style={{ fontSize: '0.8rem' }}>
                    动作变动策略 (Action Policy)
                  </label>
                  <p className="form-help" data-testid="smoke-action-policy">
                    non_submitting（固定安全策略）。经审批的业务写入必须通过独立的授权回归流程发起，
                    URL 冒烟入口不能切换为写入模式。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Start Button */}
        <div
          style={{
            marginTop: '28px',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="submit"
            className="btn btn-primary"
            style={{ fontSize: '1rem', padding: '10px 24px', fontWeight: 600 }}
            disabled={
              starting ||
              optionsLoading ||
              Boolean(optionsError) ||
              missingModel ||
              currentProject.status !== 'active'
            }
            data-testid="btn-start-smoke-run"
          >
            {starting ? '正在建立运行...' : '开始冒烟测试'}
          </button>
        </div>
      </form>
    </div>
  );
};
