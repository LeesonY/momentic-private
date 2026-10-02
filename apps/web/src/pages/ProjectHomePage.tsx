import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import type {
  Environment,
  AuthProfile,
  ModelProfile,
} from '@localqa/contracts';

export const ProjectHomePage: React.FC = () => {
  const { currentProject, setRoute } = useApp();

  const [targetUrl, setTargetUrl] = useState('http://localhost:8080/');
  const [description, setDescription] = useState('');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [selectedAuthId, setSelectedAuthId] = useState<string>('');
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  // Advanced Budget Overrides
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxCases, setMaxCases] = useState(8);
  const [maxPages, setMaxPages] = useState(6);
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxActiveSeconds, setMaxActiveSeconds] = useState(600);
  const [maxActions, setMaxActions] = useState(120);
  const [maxModelCalls] = useState(100);
  const [maxReproductions] = useState(3);
  const [actionPolicy, setActionPolicy] = useState<
    'non_submitting' | 'approved_workflows'
  >('non_submitting');

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function loadOptions() {
      try {
        const [envRes, authRes, modelRes] = await Promise.all([
          defaultApiClient.listEnvironments(projId),
          defaultApiClient.listAuthProfiles(projId),
          defaultApiClient.listModels(),
        ]);
        setEnvironments(envRes.items);
        if (envRes.items.length > 0) setSelectedEnvId(envRes.items[0].id);

        setAuthProfiles(authRes.items);
        if (authRes.items.length > 0) setSelectedAuthId(authRes.items[0].id);

        setModels(modelRes.items);
        if (modelRes.items.length > 0) setSelectedModelId(modelRes.items[0].id);
      } catch (err) {
        console.warn('Failed to load project options:', err);
      }
    }
    loadOptions();
  }, [currentProject]);

  const selectedModel = models.find((m) => m.id === selectedModelId);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUrl.trim()) {
      setError('请输入有效的被测目标 URL');
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const run = await defaultApiClient.createRun({
        projectId: currentProject?.id || 'proj_default',
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
        config: {
          actionPolicy,
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

  return (
    <div
      style={{ maxWidth: '880px', margin: '0 auto' }}
      data-testid="project-home-page"
    >
      <div style={{ marginBottom: '24px' }}>
        <h1
          style={{
            fontSize: '1.6rem',
            fontWeight: 700,
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

      <form onSubmit={handleStart} className="card" style={{ padding: '28px' }}>
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
              onChange={(e) => setSelectedEnvId(e.target.value)}
              data-testid="select-environment"
            >
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
              {authProfiles.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.mode})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">分析与推理模型 (Model Profile)</label>
            <select
              className="form-select"
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              data-testid="select-model-profile"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{' '}
                  {m.dataBoundary === 'internal' ? '[内网]' : '[外部商业]'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* External Model Data Destination Notice */}
        {selectedModel && selectedModel.dataBoundary === 'external' && (
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
            当前选择的模型由外部云端商业提供商（如
            OpenAI）承载。自动化探索期间，脱敏后的 DOM 结构、accessible name
            与必要截图将出网传输至外部模型服务器。请确认被测系统不包含未经授权的非公开核心涉密数据。
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
                  <select
                    className="form-select"
                    value={actionPolicy}
                    onChange={(e) =>
                      setActionPolicy(
                        e.target.value as
                          'non_submitting' | 'approved_workflows',
                      )
                    }
                  >
                    <option value="non_submitting">
                      non_submitting (严格避免表单提交与副作用)
                    </option>
                    <option value="approved_workflows">
                      approved_workflows (允许执行预核准业务流程)
                    </option>
                  </select>
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
            disabled={starting}
            data-testid="btn-start-smoke-run"
          >
            {starting ? '正在建立运行...' : '开始冒烟测试 (Start Smoke Run) 🚀'}
          </button>
        </div>
      </form>
    </div>
  );
};
