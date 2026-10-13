import React, { useEffect, useState } from 'react';
import { useApp, type AppRoute } from '../../state/AppContext.tsx';
import { StatusBadge } from '../ui/Badge.tsx';
import { AppIcon, type AppIconName } from '../ui/AppIcon.tsx';
import { ThemeToggle } from '../ui/ThemeToggle.tsx';
import { CreateProjectDialog } from './CreateProjectDialog.tsx';
import { RecentRuns } from './RecentRuns.tsx';

type NavItem = { key: AppRoute; label: string; icon: AppIconName };

// One flat list in Mo's order; models and members live under Settings.
const mainNav: NavItem[] = [
  { key: 'home', label: '新建会话', icon: 'plus' },
  { key: 'sessions', label: '会话', icon: 'activity' },
  { key: 'schedules', label: '定时回归', icon: 'calendar' },
  { key: 'saved-cases', label: '用例库', icon: 'layers' },
  { key: 'modules', label: '模块库', icon: 'boxes' },
  { key: 'environments', label: '环境与认证', icon: 'shield' },
  { key: 'knowledge', label: '知识库', icon: 'book' },
];

const settingsNav: { label: string; items: NavItem[] }[] = [
  {
    label: '项目',
    items: [{ key: 'members-ops', label: '成员与运维', icon: 'users' }],
  },
  {
    label: '平台',
    items: [{ key: 'models', label: '模型管理', icon: 'cpu' }],
  },
];
const settingsRoutes = new Set<AppRoute>(
  settingsNav.flatMap((group) => group.items.map((item) => item.key)),
);

// Detail pages highlight the list they were opened from.
const parentRoute: Partial<Record<AppRoute, AppRoute>> = {
  workbench: 'sessions',
  'case-detail': 'sessions',
  'finding-detail': 'sessions',
  'saved-case-detail': 'saved-cases',
};

export const AppShell: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [creatingProject, setCreatingProject] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const {
    currentUser,
    projects,
    currentProject,
    currentRoute,
    setRoute,
    setCurrentProject,
    isMock,
    toggleMock,
    logout,
  } = useApp();
  const activeRoute = parentRoute[currentRoute] ?? currentRoute;
  const inSettings = settingsRoutes.has(activeRoute);

  useEffect(() => setMenuOpen(false), [currentRoute]);

  const navigate = (route: AppRoute) => {
    setMenuOpen(false);
    setRoute(route);
  };

  return (
    <div className="lqa-shell">
      <header
        className={`lqa-sidebar ${menuOpen ? 'is-open' : ''}`}
        data-testid="app-header"
      >
        <div className="lqa-sidebar-top">
          <div className="lqa-project-field">
            {projects.length > 0 && currentProject ? (
              <select
                className="lqa-project-select"
                aria-label="切换项目"
                value={currentProject.id}
                onChange={(event) => {
                  const selected = projects.find(
                    (project) => project.id === event.target.value,
                  );
                  if (selected) {
                    setCurrentProject(selected);
                    navigate('home');
                  }
                }}
                data-testid="project-selector"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                    {projects.some(
                      (other) =>
                        other.id !== project.id && other.name === project.name,
                    )
                      ? ` · ID ${project.id.slice(0, 8)}`
                      : ''}
                    {project.status === 'archived' ? '（已归档）' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span className="lqa-project-empty">尚未创建项目</span>
            )}
            <AppIcon name="chevron-down" size={14} />
          </div>
          {currentUser?.globalRole === 'admin' && (
            <button
              type="button"
              className="lqa-icon-button lqa-create-project"
              aria-label="新建项目"
              title="新建项目"
              data-testid="btn-create-project"
              onClick={() => setCreatingProject(true)}
            >
              <AppIcon name="plus" size={16} />
            </button>
          )}
          <button
            type="button"
            className="lqa-icon-button lqa-menu-button"
            aria-label={menuOpen ? '关闭导航菜单' : '打开导航菜单'}
            aria-expanded={menuOpen}
            aria-controls="lqa-sidebar-panel"
            onClick={() => setMenuOpen((open) => !open)}
            data-testid="btn-mobile-menu"
          >
            <AppIcon name={menuOpen ? 'close' : 'menu'} size={20} />
          </button>
        </div>

        <div id="lqa-sidebar-panel" className="lqa-sidebar-panel">
          {inSettings ? (
            <nav
              className="lqa-sidebar-nav lqa-settings-nav"
              aria-label="设置导航"
              data-testid="settings-navigation"
            >
              <button
                type="button"
                className="lqa-nav-link lqa-nav-back"
                onClick={() => navigate('home')}
                data-testid="nav-back-to-app"
              >
                <AppIcon name="chevron-left" size={16} />
                <span>返回应用</span>
              </button>
              {settingsNav.map((group) => (
                <div className="lqa-nav-group" key={group.label}>
                  <div className="lqa-nav-group-label">{group.label}</div>
                  {group.items.map(({ key, label, icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`lqa-nav-link ${activeRoute === key ? 'is-active' : ''}`}
                      aria-current={activeRoute === key ? 'page' : undefined}
                      onClick={() => navigate(key)}
                      data-testid={`nav-${key}`}
                    >
                      <AppIcon name={icon} size={16} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          ) : (
            <nav
              className="lqa-sidebar-nav"
              aria-label="主导航"
              data-testid="main-navigation"
            >
              <div className="lqa-nav-group">
                {mainNav.map(({ key, label, icon }) => (
                  <button
                    key={key}
                    type="button"
                    className={`lqa-nav-link ${activeRoute === key ? 'is-active' : ''}`}
                    aria-current={activeRoute === key ? 'page' : undefined}
                    onClick={() => navigate(key)}
                    data-testid={`nav-${key}`}
                  >
                    <AppIcon name={icon} size={16} />
                    <span>{label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="lqa-nav-link"
                  onClick={() => navigate('members-ops')}
                  data-testid="nav-settings"
                >
                  <AppIcon name="settings" size={16} />
                  <span>设置</span>
                </button>
              </div>
            </nav>
          )}

          {currentUser && !inSettings && (
            <RecentRuns onNavigate={() => setMenuOpen(false)} />
          )}

          <div className="lqa-sidebar-footer">
            <div className="lqa-sidebar-controls">
              <button
                type="button"
                className={`lqa-mode-indicator ${isMock ? 'is-mock' : ''}`}
                title={isMock ? '切换到真实 API 模式' : '切换到演示模式'}
                aria-label={
                  isMock ? 'Mock 模式，点击切换' : '真实 API 模式，点击切换'
                }
                onClick={() => toggleMock(!isMock)}
                data-testid="mock-mode-indicator"
              >
                <span className="lqa-live-dot" />
                {isMock ? '演示模式' : '真实 API'}
              </button>
              <ThemeToggle />
            </div>
            {currentUser ? (
              <div className="lqa-user">
                <span className="lqa-user-avatar" aria-hidden="true">
                  {currentUser.email.slice(0, 1).toUpperCase()}
                </span>
                <div className="lqa-user-meta">
                  <span className="lqa-user-email" title={currentUser.email}>
                    {currentUser.email}
                  </span>
                  <StatusBadge status={currentUser.globalRole} size="sm" />
                </div>
                <button
                  className="lqa-icon-button"
                  type="button"
                  onClick={() => void logout()}
                  aria-label="退出登录"
                  title="退出登录"
                  data-testid="btn-logout"
                >
                  <AppIcon name="log-out" size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={() => navigate('login')}
                data-testid="btn-login-nav"
              >
                登录
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="lqa-shell-main">
        {isMock && (
          <div className="lqa-demo-banner" data-testid="offline-mock-banner">
            <AppIcon name="info" size={14} />
            <span>当前为离线演示模式，数据不会写入真实服务。</span>
            <button type="button" onClick={() => toggleMock(false)}>
              切换真实 API
            </button>
          </div>
        )}
        <main className="lqa-main">{children}</main>
      </div>

      {creatingProject && (
        <CreateProjectDialog onClose={() => setCreatingProject(false)} />
      )}
    </div>
  );
};
