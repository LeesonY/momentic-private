import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppIcon, type AppIconName } from '../components/ui/AppIcon.tsx';
import { CreateProjectDialog } from '../components/layout/CreateProjectDialog.tsx';
import { Page } from '../components/layout/Page.tsx';
import { Popover } from '../components/ui/Popover.tsx';
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

type TaskIntent = NonNullable<
  import('@localqa/contracts').RunConfig['taskIntent']
>;

/** Mo's "start with a brief" cards: each fills the composer with a request
 * whose 【】 blanks the user replaces before sending. */
// Concurrent sub-agents a session may run; matches budget.concurrency's cap.
const MAX_AGENTS = 25;

const BRIEFS: {
  intent: TaskIntent;
  icon: AppIconName;
  tone: 'info' | 'danger' | 'warning' | 'ai' | 'success';
  title: string;
  text: string;
  prompt: string;
}[] = [
  {
    intent: 'flow',
    icon: 'play',
    tone: 'info',
    title: '测试一个流程',
    text: '给出预发或测试环境，说明要测的流程。',
    prompt:
      '测试这个流程：【例如 注册 → 登录 → 下单】。预期：【应该看到的结果】。',
  },
  {
    intent: 'explore',
    icon: 'bug',
    tone: 'danger',
    title: '集中找一片区域的缺陷',
    text: 'AI 探索一个功能区域并提交缺陷。',
    prompt: '探索【功能区域】，找出缺陷；不要【需要避开的操作】。',
  },
  {
    intent: 'reproduce',
    icon: 'target',
    tone: 'warning',
    title: '复现一个问题',
    text: '交给 AI 一份问题描述，由它尝试复现。',
    prompt: '复现这个问题：【现象】。复现步骤：【步骤】。预期：【正确结果】。',
  },
  {
    intent: 'plan',
    icon: 'list',
    tone: 'ai',
    title: '规划测试用例',
    text: 'AI 起草要执行的测试用例，先不运行。',
    prompt: '为【功能或用户旅程】起草测试用例，先不执行。',
  },
  {
    intent: 'changes',
    icon: 'git-branch',
    tone: 'success',
    title: '回归最近的改动',
    text: '说明改了什么，AI 找出受影响的流程并验证。',
    prompt: '这次改动：【变更说明或代码差异】。请找出受影响的流程并逐个验证。',
  },
  {
    intent: 'spec',
    icon: 'file-text',
    tone: 'info',
    title: '按规格测试',
    text: '贴上需求或测试计划，AI 推导用例并执行。',
    prompt: '按下面的需求推导测试用例并执行：【粘贴需求或验收标准】',
  },
];

export const ProjectHomePage: React.FC = () => {
  const { currentProject, currentUser, isMock, setRoute } = useApp();
  const [creatingProject, setCreatingProject] = useState(false);

  const [prompt, setPrompt] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [taskIntent, setTaskIntent] = useState<TaskIntent>('flow');
  const [allowWrites, setAllowWrites] = useState(false);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [selectedAuthId, setSelectedAuthId] = useState<string>('');
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Budget overrides (session settings popover)
  const [maxCases, setMaxCases] = useState(8);
  const [maxPages, setMaxPages] = useState(6);
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxActiveSeconds, setMaxActiveSeconds] = useState(600);
  const [maxActions, setMaxActions] = useState(120);
  const [maxActionsPerCase, setMaxActionsPerCase] = useState(24);
  const [concurrency, setConcurrency] = useState(2);
  const [maxModelCalls] = useState(100);
  const [maxReproductions] = useState(3);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
    if (allowWrites && taskIntent !== 'plan' && !selectedEnvId) {
      setError('允许业务操作时，请选择测试环境');
      return;
    }
    const text = prompt.trim();
    if (/【[^】]*】/.test(text)) {
      setError('请把【】里的内容换成实际信息后再开始。');
      return;
    }
    // Like Mo, the address can be written into the request; otherwise the
    // selected environment's base URL is where the session starts.
    const mentioned = text.match(/https?:\/\/[^\s，。；、）)】]+/)?.[0];
    const targetUrl =
      mentioned ??
      environments.find((env) => env.id === selectedEnvId)?.baseUrl;
    if (!targetUrl) {
      setError('请在描述里写上要测试的网址，或在“环境”里选择一个测试环境。');
      return;
    }
    const description = text === mentioned ? '' : text;
    if (['spec', 'changes', 'reproduce'].includes(taskIntent) && !description) {
      setError('请描述要测试的需求、变更或问题。');
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const run = await defaultApiClient.createRun({
        projectId: currentProject.id,
        targetUrl,
        description: description || undefined,
        taskIntent,
        actionPolicy:
          allowWrites && taskIntent !== 'plan'
            ? 'approved_workflows'
            : 'non_submitting',
        environmentId: selectedEnvId || undefined,
        authProfileId: selectedAuthId || undefined,
        modelProfileId: selectedModelId || undefined,
        budgetOverrides: {
          maxCases,
          maxPages,
          maxDepth,
          maxActiveSeconds,
          maxActions,
          maxActionsPerCase,
          concurrency,
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
  const selectedEnv = environments.find((env) => env.id === selectedEnvId);
  const activeIntent = BRIEFS.find((item) => item.intent === taskIntent)!;
  const usesDefaultAuth =
    !!selectedAuthId && selectedEnv?.defaultAuthProfileId === selectedAuthId;
  const startDisabled =
    starting ||
    optionsLoading ||
    Boolean(optionsError) ||
    missingModel ||
    currentProject.status !== 'active';

  const chooseEnvironment = (envId: string) => {
    setSelectedEnvId(envId);
    const env = environments.find((item) => item.id === envId);
    setSelectedAuthId(configuredDefaultAuth(env, authProfiles));
    if (!env) setAllowWrites(false);
  };

  return (
    <Page testId="project-home-page" className="lqa-home">
      <div className="mo-new-session">
        {error && (
          <Alert tone="danger" testId="home-error-banner">
            {error}
          </Alert>
        )}

        <form className="mo-composer is-hero" onSubmit={handleStart}>
          <textarea
            ref={composerRef}
            className="mo-composer-input"
            rows={2}
            maxLength={4000}
            aria-label="要测试的内容"
            placeholder="告诉 AI 要测试哪个流程，例如注册或下单…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!startDisabled) e.currentTarget.form?.requestSubmit();
              }
            }}
            data-testid="composer-input"
          />
          <div className="mo-composer-bar">
            <div className="mo-composer-tools">
              <Popover
                title="会话设置"
                testId="session-settings-popover"
                className="mo-settings-popover"
                trigger={(props) => (
                  <button
                    type="button"
                    {...props}
                    className="mo-tool-button"
                    aria-label="会话设置"
                    title="会话设置"
                    data-testid="btn-session-settings"
                  >
                    <AppIcon name="sliders" size={16} />
                  </button>
                )}
              >
                <label className="mo-setting-row">
                  <span>
                    <AppIcon name="cpu" size={15} /> 模型
                  </span>
                  <select
                    aria-label="本次运行模型"
                    value={selectedModelId}
                    onChange={(e) => setSelectedModelId(e.target.value)}
                    data-testid="select-model-profile"
                  >
                    <option value="">
                      {projectDefaultModel
                        ? `默认：${projectDefaultModel.name}`
                        : '项目默认或授权模型'}
                    </option>
                    {models
                      .filter((m) => m.status !== 'disabled')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}（
                          {m.dataBoundary === 'external' ? '外部' : '内部'}）
                        </option>
                      ))}
                  </select>
                </label>
                <label className="mo-setting-row">
                  <span>
                    <AppIcon name="key" size={15} /> 登录凭据
                  </span>
                  <select
                    aria-label="认证凭据"
                    value={selectedAuthId}
                    onChange={(e) => setSelectedAuthId(e.target.value)}
                    data-testid="select-auth-profile"
                  >
                    <option value="">匿名访问</option>
                    {authOptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  className={`mo-setting-row ${taskIntent === 'plan' || !selectedEnvId ? 'is-disabled' : ''}`}
                  title={
                    taskIntent === 'plan'
                      ? '只生成计划时不操作页面'
                      : !selectedEnvId
                        ? '先在“环境”里选择测试环境'
                        : undefined
                  }
                >
                  <span>
                    <AppIcon name="edit" size={15} /> 允许业务操作
                  </span>
                  <input
                    type="checkbox"
                    checked={allowWrites}
                    disabled={taskIntent === 'plan' || !selectedEnvId}
                    onChange={(e) => setAllowWrites(e.target.checked)}
                    data-testid="allow-business-writes"
                  />
                </label>
                <p
                  className="mo-setting-hint"
                  data-testid="smoke-action-policy"
                >
                  {allowWrites
                    ? '可以在所选测试环境中创建、修改和清理测试数据。'
                    : '只浏览、填写和检查，不提交业务数据。'}
                </p>
                <details className="mo-setting-budget">
                  <summary>额度</summary>
                  <div className="mo-setting-grid">
                    {(
                      [
                        ['最多用例', maxCases, setMaxCases, 1, 30],
                        ['最多页面', maxPages, setMaxPages, 1, 30],
                        ['探索深度', maxDepth, setMaxDepth, 0, 5],
                        [
                          '最长秒数',
                          maxActiveSeconds,
                          setMaxActiveSeconds,
                          60,
                          3600,
                        ],
                        ['最多步数', maxActions, setMaxActions, 10, 1000],
                        [
                          '单用例步数',
                          maxActionsPerCase,
                          setMaxActionsPerCase,
                          1,
                          100,
                        ],
                      ] as const
                    ).map(([label, value, setter, min, max]) => (
                      <label key={label}>
                        <span>{label}</span>
                        <input
                          type="number"
                          className="form-input"
                          min={min}
                          max={max}
                          value={value}
                          onChange={(e) => setter(Number(e.target.value))}
                        />
                      </label>
                    ))}
                  </div>
                </details>
              </Popover>
              <Popover
                title="最多并发代理"
                testId="agents-popover"
                trigger={(props) => (
                  <button
                    type="button"
                    {...props}
                    className="mo-tool-button is-labeled"
                    aria-label="最多并发代理"
                    data-testid="agent-concurrency-picker"
                  >
                    <AppIcon name="users" size={16} />
                    <span>代理</span>
                    <span className="mo-tool-value">{concurrency}</span>
                  </button>
                )}
              >
                <div className="mo-range">
                  <div className="mo-range-row">
                    <input
                      type="range"
                      min={1}
                      max={MAX_AGENTS}
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      aria-label="并发代理数"
                      data-testid="agent-concurrency-range"
                    />
                    <input
                      type="number"
                      className="form-input"
                      min={1}
                      max={MAX_AGENTS}
                      value={concurrency}
                      onChange={(e) => {
                        const value = Math.round(Number(e.target.value));
                        if (Number.isFinite(value))
                          setConcurrency(
                            Math.min(MAX_AGENTS, Math.max(1, value)),
                          );
                      }}
                      aria-label="并发代理数"
                      data-testid="agent-concurrency-number"
                    />
                  </div>
                  <div className="mo-range-scale">
                    <span>1</span>
                    <span>{MAX_AGENTS}</span>
                  </div>
                  <p className="mo-setting-hint">
                    同时工作的子代理上限，实际并发还受平台配额限制。
                  </p>
                </div>
              </Popover>
              <Popover
                title="环境"
                testId="environment-popover"
                className="mo-env-popover"
                trigger={(props) => (
                  <button
                    type="button"
                    {...props}
                    className="mo-tool-button is-labeled"
                    aria-label="运行环境"
                    data-env-id={selectedEnvId}
                    data-testid="btn-environment"
                  >
                    <AppIcon name="shield" size={16} />
                    <span className="mo-tool-env">
                      {selectedEnv?.name ?? '环境'}
                    </span>
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {environments.length === 0 ? (
                      <p className="mo-popover-empty">还没有配置环境。</p>
                    ) : (
                      <div role="listbox" aria-label="选择环境">
                        {[
                          { id: '', name: '不指定环境', baseUrl: '' },
                          ...environments,
                        ].map((env) => (
                          <button
                            key={env.id || 'none'}
                            type="button"
                            role="option"
                            aria-selected={selectedEnvId === env.id}
                            className="mo-menu-item"
                            onClick={() => {
                              chooseEnvironment(env.id);
                              close();
                            }}
                            data-testid={`env-option-${env.id || 'none'}`}
                          >
                            <span className="mo-menu-item-text">
                              <span>{env.name}</span>
                              {env.baseUrl && (
                                <span className="mo-menu-item-sub">
                                  {env.baseUrl}
                                </span>
                              )}
                            </span>
                            {selectedEnvId === env.id && (
                              <AppIcon name="check" size={14} />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="mo-menu-footer"
                      onClick={() => setRoute('environments')}
                    >
                      管理环境
                    </button>
                  </>
                )}
              </Popover>
              {taskIntent !== 'flow' && (
                <span className="mo-intent-chip" data-testid="active-intent">
                  {activeIntent.title}
                  <button
                    type="button"
                    aria-label="改回测试一个流程"
                    onClick={() => setTaskIntent('flow')}
                  >
                    <AppIcon name="close" size={12} />
                  </button>
                </span>
              )}
            </div>
            <button
              type="submit"
              className="mo-send-button"
              aria-label="开始会话"
              title="开始会话（Enter）"
              disabled={startDisabled}
              data-testid="btn-start-smoke-run"
            >
              {starting ? (
                <span className="mo-send-spinner" />
              ) : (
                <AppIcon name="arrow-up" size={16} />
              )}
            </button>
          </div>
        </form>

        <div className="mo-composer-notes" data-testid="run-write-policy-notice">
          <label>
            <input
              type="checkbox"
              checked={allowWrites && taskIntent !== 'plan' && !!selectedEnvId}
              disabled={taskIntent === 'plan' || !selectedEnvId || starting}
              onChange={(event) => setAllowWrites(event.target.checked)}
              data-testid="allow-business-writes-visible"
            />
            {' '}
            {allowWrites && taskIntent !== 'plan' && !!selectedEnvId
              ? '已启用业务写操作：仅在所选测试环境与授权范围内执行，可能产生测试数据。'
              : '当前为只读测试：不能提交新建、修改或删除操作。需要测试提交时请明确勾选。'}
          </label>
        </div>

        {(usesDefaultAuth || !selectedEnv) && (
          <div className="mo-composer-notes">
            {usesDefaultAuth && (
              <span data-testid="default-auth-notice">
                使用环境默认登录：
                {authProfiles.find((a) => a.id === selectedAuthId)?.name}
              </span>
            )}
            {!selectedEnv && (
              <span>没有选择环境时，请在描述里写上要测试的网址。</span>
            )}
          </div>
        )}

        {!isMock && (optionsLoading || optionsError || missingModel) && (
          <Alert
            tone="warning"
            title="暂时不能开始会话"
            testId="model-unconfigured-notice"
          >
            {optionsLoading
              ? '正在加载项目配置…'
              : optionsError
                ? `配置读取失败：${optionsError}`
                : '当前没有可用模型。请由管理员在“设置 → 模型管理”中完成配置与项目授权，系统不会自动使用模拟模型。'}
          </Alert>
        )}
        {showExternalNotice && (
          <p className="mo-composer-notes" data-testid="external-model-notice">
            使用外部模型时，脱敏后的页面结构和获准截图会发送给对应服务商。
          </p>
        )}

        <div className="mo-briefs-divider">
          <span>或者从一个模板开始</span>
        </div>
        <div className="mo-briefs" data-testid="task-intents">
          {BRIEFS.map((item) => (
            <button
              key={item.intent}
              type="button"
              className="mo-brief"
              aria-pressed={taskIntent === item.intent}
              data-testid={`task-intent-${item.intent}`}
              onClick={() => {
                setTaskIntent(item.intent);
                if (item.intent === 'plan') setAllowWrites(false);
                setPrompt(item.prompt);
                setError(null);
                window.requestAnimationFrame(() => {
                  const box = composerRef.current;
                  if (!box) return;
                  box.focus();
                  const blank = item.prompt.indexOf('【');
                  if (blank >= 0)
                    box.setSelectionRange(
                      blank,
                      item.prompt.indexOf('】', blank) + 1,
                    );
                });
              }}
            >
              <AppIcon
                name={item.icon}
                size={18}
                className={`mo-brief-icon is-${item.tone}`}
              />
              <span className="mo-brief-title">{item.title}</span>
              <span className="mo-brief-text">{item.text}</span>
              <span className="mo-brief-prompt">
                <AppIcon name="play" size={12} />
                <span>{item.prompt}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Page>
  );
};
