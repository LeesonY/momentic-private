import React, { useEffect, useState } from 'react';
import { useApp, type AppRoute } from '../../state/AppContext.tsx';
import { StatusBadge } from '../ui/Badge.tsx';
import { AppIcon, type AppIconName } from '../ui/AppIcon.tsx';
import { ThemeToggle } from '../ui/ThemeToggle.tsx';
import { CreateProjectDialog } from './CreateProjectDialog.tsx';

const navItems: { key: AppRoute; label: string; icon: AppIconName }[] = [
  { key: 'home', label: '项目首页', icon: 'grid' },
  { key: 'workbench', label: '运行工作台', icon: 'activity' },
  { key: 'saved-cases', label: '用例库', icon: 'layers' },
  { key: 'schedules', label: '定时回归', icon: 'calendar' },
  { key: 'modules', label: '模块库', icon: 'boxes' },
  { key: 'environments', label: '环境与认证', icon: 'shield' },
  { key: 'knowledge', label: '项目知识', icon: 'book' },
  { key: 'models', label: '模型管理', icon: 'cpu' },
  { key: 'members-ops', label: '成员与运维', icon: 'users' },
];

export const AppHeader: React.FC = () => {
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

  useEffect(() => setMenuOpen(false), [currentRoute]);

  const navigate = (route: AppRoute) => {
    setMenuOpen(false);
    setRoute(route);
  };

  const navigation = (mobile: boolean) => (
    <nav
      className={mobile ? 'lqa-mobile-nav' : 'lqa-desktop-nav'}
      aria-label={mobile ? '移动端主导航' : '主导航'}
      data-testid={mobile ? 'mobile-navigation' : 'main-navigation'}
    >
      {navItems.map(({ key, label, icon }) => (
        <button
          key={key}
          type="button"
          className={`lqa-nav-link ${currentRoute === key ? 'is-active' : ''}`}
          aria-current={currentRoute === key ? 'page' : undefined}
          onClick={() => navigate(key)}
          data-testid={mobile ? `mobile-nav-${key}` : `nav-${key}`}
        >
          <AppIcon name={icon} size={17} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );

  return (
    <>
      {isMock && (
        <div className="lqa-demo-banner" data-testid="offline-mock-banner">
          <span>当前为离线演示模式，数据不会写入真实服务。</span>
          <button type="button" onClick={() => toggleMock(false)}>
            切换真实 API
          </button>
        </div>
      )}
      <header className="lqa-shell-header" data-testid="app-header">
        <div className="lqa-topbar">
          <div className="lqa-brand-area">
            <button
              className="lqa-brand"
              type="button"
              onClick={() => navigate('home')}
              aria-label="LocalQA 项目首页"
              data-testid="app-logo-home"
            >
              <span className="lqa-brand-mark">
                <AppIcon name="layers" size={22} />
              </span>
              <span className="lqa-brand-wordmark">
                Local<span>QA</span>
              </span>
            </button>
            <span className="lqa-brand-divider" aria-hidden="true" />
            <div className="lqa-workspace-select">
              {projects.length > 0 && currentProject ? (
                <>
                  <AppIcon name="folder" size={16} />
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
                            other.id !== project.id &&
                            other.name === project.name,
                        )
                          ? ` · ID ${project.id.slice(0, 8)}`
                          : ''}
                        {project.status === 'archived' ? '（已归档）' : ''}
                      </option>
                    ))}
                  </select>
                  <AppIcon name="chevron-down" size={14} />
                </>
              ) : (
                <span>我的工作空间</span>
              )}
            </div>
          </div>

          <div className="lqa-header-actions">
            {currentUser?.globalRole === 'admin' && (
              <button
                type="button"
                className="btn btn-primary btn-sm lqa-create-button"
                data-testid="btn-create-project"
                onClick={() => setCreatingProject(true)}
              >
                <AppIcon name="plus" size={16} />
                <span>新建项目</span>
              </button>
            )}
            <button
              type="button"
              className={`lqa-environment-indicator ${isMock ? 'is-mock' : ''}`}
              title={isMock ? '切换到真实 API 模式' : '切换到 Mock 演示模式'}
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
            {currentUser ? (
              <div className="lqa-user-controls">
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
                  className="lqa-icon-button lqa-logout"
                  type="button"
                  onClick={logout}
                  aria-label="退出登录"
                  title="退出登录"
                  data-testid="btn-logout"
                >
                  <AppIcon name="log-out" size={18} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => navigate('login')}
                data-testid="btn-login-nav"
              >
                登录
              </button>
            )}
            <button
              type="button"
              className="lqa-icon-button lqa-menu-button"
              aria-label={menuOpen ? '关闭导航菜单' : '打开导航菜单'}
              aria-expanded={menuOpen}
              aria-controls="lqa-mobile-menu"
              onClick={() => setMenuOpen((open) => !open)}
              data-testid="btn-mobile-menu"
            >
              <AppIcon name={menuOpen ? 'close' : 'menu'} size={20} />
            </button>
          </div>
        </div>

        <div className="lqa-nav-strip">
          <div className="lqa-nav-inner">{navigation(false)}</div>
        </div>
        {menuOpen && (
          <div id="lqa-mobile-menu" className="lqa-mobile-menu">
            {navigation(true)}
            {currentUser?.globalRole === 'admin' && (
              <button
                type="button"
                className="btn btn-primary lqa-menu-create"
                onClick={() => {
                  setMenuOpen(false);
                  setCreatingProject(true);
                }}
              >
                <AppIcon name="plus" size={17} />
                新建项目
              </button>
            )}
            {currentUser && (
              <button
                type="button"
                className="lqa-nav-link lqa-mobile-logout"
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
                data-testid="mobile-btn-logout"
              >
                <AppIcon name="log-out" size={17} />
                <span>退出登录</span>
              </button>
            )}
          </div>
        )}
      </header>
      {creatingProject && (
        <CreateProjectDialog onClose={() => setCreatingProject(false)} />
      )}
    </>
  );
};
