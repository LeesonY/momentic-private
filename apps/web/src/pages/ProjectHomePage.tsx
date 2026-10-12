import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppIcon, type AppIconName } from '../components/ui/AppIcon.tsx';
import { CreateProjectDialog } from '../components/layout/CreateProjectDialog.tsx';
import { Page } from '../components/layout/Page.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';
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
      <Page testId="no-project-empty-state">
        <div className="lqa-empty-hero">
          <div>
            <div className="lqa-eyebrow">
              <AppIcon name="sparkles" size={15} />
              自动化质量工作台
            </div>
            <h1>让每一次测试，都更有把握。</h1>
            <p>
              将站点探索、测试执行、缺陷复现和证据报告汇集在一个工作空间。
              从创建第一个项目开始，建立可追踪的自动化质量流程。
            </p>
            <div className="lqa-hero-actions">
              {currentUser?.globalRole === 'admin' ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={() => setCreatingProject(true)}
                    data-testid="empty-create-project"
                  >
                    <AppIcon name="plus" size={17} />
                    创建第一个项目
                    <AppIcon name="arrow-right" size={16} />
                  </button>
                  <span className="lqa-hero-note">
                    大约需要 1 分钟即可开始配置
                  </span>
                </>
              ) : (
                <span className="lqa-hero-note">
                  尚未获得项目访问权限，请联系平台管理员。
                </span>
              )}
            </div>
          </div>
          <div className="lqa-hero-visual" aria-hidden="true">
            <div className="lqa-visual-halo" />
            <div className="lqa-visual-window">
              <AppIcon name="globe" size={32} />
              <div className="lqa-window-line" />
              <div className="lqa-window-line" />
              <div className="lqa-window-line" />
            </div>
            <div className="lqa-visual-check">
              <AppIcon name="check" size={28} />
            </div>
          </div>
        </div>
        <div>
          <h2 className="lqa-onboarding-heading">
            三个步骤，构建你的自动化测试流程
          </h2>
          <div className="lqa-onboarding-grid">
            {[
              {
                icon: 'folder' as const,
                title: '创建测试项目',
                text: '集中管理目标站点、成员权限与自动化测试任务。',
              },
              {
                icon: 'shield' as const,
                title: '配置环境与模型',
                text: '设置测试站点、认证方式和项目可使用的 AI 模型。',
              },
              {
                icon: 'activity' as const,
                title: '发起测试并查看报告',
                text: '通过运行工作台查看执行过程、结果与缺陷证据。',
              },
            ].map((step, index) => (
              <div className="lqa-step-card" key={step.title}>
                <div className="lqa-step-icon">
                  <AppIcon name={step.icon} size={19} />
                </div>
                <div>
                  <span className="lqa-step-index">第 {index + 1} 步</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        {creatingProject && (
          <CreateProjectDialog onClose={() => setCreatingProject(false)} />
        )}
      </Page>
    );
  }

  const authOptions = authProfiles.filter(
    (a) =>
      a.status === 'active' &&
      (!a.environmentId || a.environmentId === selectedEnvId),
  );
  const showExternalNotice =
    !isMock &&
    (selectedModelId
      ? models.find((m) => m.id === selectedModelId)?.dataBoundary ===
        'external'
      : models.some((m) => m.dataBoundary === 'external'));

  const focusUrl = () => document.getElementById('input-target-url')?.focus();
  const briefs: {
    icon: AppIconName;
    tone: string;
    title: string;
    text: string;
    onClick: () => void;
  }[] = [
    {
      icon: 'globe',
      tone: 'is-info',
      title: '冒烟测试一个网址',
      text: '填入网址，系统在限定范围内探索页面，生成并执行检查。',
      onClick: focusUrl,
    },
    {
      icon: 'layers',
      tone: 'is-success',
      title: '回归已保存的用例',
      text: '从用例库挑选用例，按审查过的基线重新执行。',
      onClick: () => setRoute('saved-cases'),
    },
    {
      icon: 'calendar',
      tone: 'is-warning',
      title: '设置定时回归',
      text: '按计划自动运行回归，结果出现在运行工作台。',
      onClick: () => setRoute('schedules'),
    },
    {
      icon: 'shield',
      tone: 'is-ai',
      title: '配置环境与登录',
      text: '设置可访问范围、排除路径和登录方式。',
      onClick: () => setRoute('environments'),
    },
    {
      icon: 'book',
      tone: 'is-danger',
      title: '补充项目知识',
      text: '告诉系统业务术语、规则和关键流程。',
      onClick: () => setRoute('knowledge'),
    },
    {
      icon: 'cpu',
      tone: 'is-muted',
      title: '管理模型',
      text: '接入模型、探测能力，再授权给本项目。',
      onClick: () => setRoute('models'),
    },
  ];
  const usesDefaultAuth =
    !!selectedAuthId &&
    environments.find((env) => env.id === selectedEnvId)
      ?.defaultAuthProfileId === selectedAuthId;

  return (
    <Page testId="project-home-page" className="lqa-home">
      <div className="lqa-home-inner">
        <h1 className="lqa-home-title">要测试哪个网站？</h1>

        {error && (
          <Alert tone="danger" testId="home-error-banner">
            {error}
          </Alert>
        )}

        <form className="lqa-composer" onSubmit={handleStart}>
          <input
            id="input-target-url"
            type="url"
            className="lqa-composer-url"
            aria-label="目标地址"
            placeholder="输入要测试的网址，例如 https://example.com/"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            required
            data-testid="input-target-url"
          />
          <textarea
            id="input-run-description"
            rows={2}
            maxLength={4000}
            className="lqa-composer-note"
            aria-label="测试说明（可选）"
            placeholder="测试说明（可选），例如：点击查看明细后应显示订单明细；检查列表筛选和分页；不要创建或删除数据。"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="input-run-description"
          />

          {showAdvanced && (
            <div
              className="lqa-composer-advanced"
              data-testid="advanced-budget-panel"
            >
              <div className="grid-3">
                <Field label="最多用例数" hint="1–30">
                  <input
                    type="number"
                    className="form-input"
                    value={maxCases}
                    min={1}
                    max={30}
                    onChange={(e) => setMaxCases(Number(e.target.value))}
                  />
                </Field>
                <Field label="最多探索页面数" hint="1–30">
                  <input
                    type="number"
                    className="form-input"
                    value={maxPages}
                    min={1}
                    max={30}
                    onChange={(e) => setMaxPages(Number(e.target.value))}
                  />
                </Field>
                <Field label="探索深度" hint="0–5">
                  <input
                    type="number"
                    className="form-input"
                    value={maxDepth}
                    min={0}
                    max={5}
                    onChange={(e) => setMaxDepth(Number(e.target.value))}
                  />
                </Field>
                <Field label="最长执行时间（秒）" hint="60–3600">
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
                </Field>
                <Field label="最多操作步数" hint="10–1000">
                  <input
                    type="number"
                    className="form-input"
                    value={maxActions}
                    min={10}
                    max={1000}
                    onChange={(e) => setMaxActions(Number(e.target.value))}
                  />
                </Field>
                <Field label="动作策略">
                  <p className="field-hint" data-testid="smoke-action-policy">
                    固定为
                    non_submitting（不提交表单）。经审批的业务写入须通过独立的授权回归流程发起，URL
                    冒烟入口不能切换为写入模式。
                  </p>
                </Field>
              </div>
            </div>
          )}

          <div className="lqa-composer-toolbar">
            <label className="lqa-composer-chip" title="运行环境">
              <AppIcon name="globe" size={15} />
              <select
                id="select-environment"
                aria-label="运行环境"
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
                    {e.name}（{e.baseUrl}）
                  </option>
                ))}
              </select>
            </label>
            <label className="lqa-composer-chip" title="认证凭据">
              <AppIcon name="key" size={15} />
              <select
                id="select-auth-profile"
                aria-label="认证凭据"
                value={selectedAuthId}
                onChange={(e) => setSelectedAuthId(e.target.value)}
                data-testid="select-auth-profile"
              >
                <option value="">匿名访问</option>
                {authOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.mode}）
                  </option>
                ))}
              </select>
            </label>
            <label className="lqa-composer-chip" title="本次运行模型">
              <AppIcon name="cpu" size={15} />
              <select
                id="select-model-profile"
                aria-label="本次运行模型"
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                data-testid="select-model-profile"
              >
                <option value="">
                  {projectDefaultModel
                    ? `默认模型：${projectDefaultModel.name}`
                    : '项目默认或授权模型'}
                </option>
                {models
                  .filter((m) => m.status !== 'disabled')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}（
                      {m.dataBoundary === 'external' ? '外部服务' : '内部服务'}
                      ）
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className={`lqa-composer-chip ${showAdvanced ? 'is-active' : ''}`}
              aria-expanded={showAdvanced}
              aria-label="高级额度与策略"
              title="高级额度与策略"
              onClick={() => setShowAdvanced(!showAdvanced)}
              data-testid="btn-toggle-advanced-budget"
            >
              <AppIcon name="settings" size={15} />
            </button>
            <button
              type="submit"
              className="btn btn-primary lqa-composer-submit"
              disabled={
                starting ||
                optionsLoading ||
                Boolean(optionsError) ||
                missingModel ||
                currentProject.status !== 'active'
              }
              data-testid="btn-start-smoke-run"
            >
              <AppIcon name="play" size={14} />
              {starting ? '正在建立运行...' : '开始冒烟测试'}
            </button>
          </div>
        </form>

        <div className="lqa-composer-hints">
          <span>
            主 AI
            将据此规划用例、派工和补测。请写明预期结果和禁止操作，登录凭据放在环境与认证中。
          </span>
          <span>
            冒烟测试只做导航、观察和截图，不会提交表单或写入业务数据。
          </span>
          {usesDefaultAuth && (
            <span data-testid="default-auth-notice">
              已选择环境默认认证；可手动切换为匿名访问。
            </span>
          )}
          <span data-testid="configured-model-notice">
            手动选择的模型须已授权给本项目。{' '}
            <button
              type="button"
              className="btn btn-link text-xs"
              onClick={() => setRoute('models')}
            >
              查看模型配置
            </button>
          </span>
        </div>

        {!isMock && (optionsLoading || optionsError || missingModel) && (
          <Alert
            tone="warning"
            title="暂时不能启动真实模型冒烟"
            testId="model-unconfigured-notice"
          >
            {optionsLoading
              ? '正在加载项目配置…'
              : optionsError
                ? `配置读取失败：${optionsError}`
                : '当前没有可用模型。请由管理员在“模型管理”中完成配置与项目授权，系统不会自动使用模拟模型。'}
          </Alert>
        )}
        {showExternalNotice && (
          <Alert
            tone="warning"
            title="外部模型数据去向"
            testId="external-model-notice"
          >
            已配置的模型中包含外部商业服务。若本次运行绑定外部模型，脱敏后的
            DOM、可访问名称及获准截图可能传输到相应服务商。请在项目模型配置中确认实际绑定的数据去向。
          </Alert>
        )}

        <div className="lqa-home-divider">
          <span>或者从这里开始</span>
        </div>
        <div className="lqa-briefs">
          {briefs.map((brief) => (
            <button
              type="button"
              key={brief.title}
              className="lqa-brief"
              onClick={brief.onClick}
            >
              <AppIcon
                name={brief.icon}
                size={18}
                className={`lqa-brief-icon ${brief.tone}`}
              />
              <span className="lqa-brief-title">{brief.title}</span>
              <span className="lqa-brief-text">{brief.text}</span>
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
};
