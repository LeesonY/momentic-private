import React from 'react';
import { useApp, type AppRoute } from '../../state/AppContext.tsx';
import { StatusBadge } from '../ui/Badge.tsx';

export const AppHeader: React.FC = () => {
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

  const navItems: { key: AppRoute; label: string }[] = [
    { key: 'home', label: '项目首页' },
    { key: 'workbench', label: '运行工作台' },
    { key: 'environments', label: '环境/认证' },
    { key: 'knowledge', label: '项目知识' },
    { key: 'models', label: '模型管理' },
    { key: 'members-ops', label: '成员/运维' },
  ];

  return (
    <header
      style={{
        backgroundColor: 'var(--color-bg-surface)',
        borderBottom: '1px solid var(--color-border-subtle)',
        padding: '0 24px',
        height: '60px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}
      data-testid="app-header"
    >
      {/* Brand & Project Selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
          }}
          onClick={() => setRoute('home')}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              backgroundColor: 'var(--color-primary)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontWeight: 'bold',
              fontSize: '1.1rem',
            }}
          >
            L
          </div>
          <span
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              letterSpacing: '-0.5px',
            }}
          >
            LocalQA
          </span>
        </div>

        {/* Project Selector */}
        {projects.length > 0 && currentProject && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--color-border)', fontSize: '1.2rem' }}>
              /
            </span>
            <select
              className="form-select"
              style={{
                padding: '4px 8px',
                fontSize: '0.85rem',
                width: 'auto',
                fontWeight: 500,
              }}
              value={currentProject.id}
              onChange={(e) => {
                const p = projects.find((proj) => proj.id === e.target.value);
                if (p) setCurrentProject(p);
              }}
              data-testid="project-selector"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Navigation Links */}
      <nav
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        data-testid="main-navigation"
      >
        {navItems.map((item) => {
          const isActive = currentRoute === item.key;
          return (
            <button
              key={item.key}
              onClick={() => setRoute(item.key)}
              style={{
                background: isActive
                  ? 'var(--color-primary-subtle)'
                  : 'transparent',
                color: isActive
                  ? 'var(--color-primary)'
                  : 'var(--color-text-muted)',
                fontWeight: isActive ? 600 : 500,
                border: 'none',
                padding: '6px 12px',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                fontSize: '0.875rem',
                transition: 'all 0.15s',
              }}
              data-testid={`nav-${item.key}`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* User Info & Mock Mode indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {/* Mock Badge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: isMock
              ? 'var(--color-warning-bg)'
              : 'var(--color-success-bg)',
            border: `1px solid ${isMock ? 'var(--color-warning-border)' : 'var(--color-success-border)'}`,
            padding: '3px 8px',
            borderRadius: 'var(--radius-full)',
            fontSize: '0.75rem',
            color: isMock
              ? 'var(--color-warning-text)'
              : 'var(--color-success-text)',
            cursor: 'pointer',
          }}
          title="点击切换 Mock 模式与真实 API 客户端"
          onClick={() => toggleMock(!isMock)}
          data-testid="mock-mode-indicator"
        >
          <span>{isMock ? '🧪 Mock 模式 (已启用)' : '🌐 真实 API 模式'}</span>
        </div>

        {currentUser ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-main)',
                fontWeight: 500,
              }}
            >
              {currentUser.email}
            </span>
            <StatusBadge status={currentUser.globalRole} size="sm" />
            <button
              className="btn btn-secondary btn-sm"
              onClick={logout}
              style={{ padding: '2px 8px', fontSize: '0.75rem' }}
              data-testid="btn-logout"
            >
              退出
            </button>
          </div>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setRoute('login')}
            data-testid="btn-login-nav"
          >
            登录
          </button>
        )}
      </div>
    </header>
  );
};
