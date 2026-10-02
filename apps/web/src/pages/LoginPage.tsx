import React, { useState } from 'react';
import { useApp } from '../state/AppContext.tsx';

export const LoginPage: React.FC = () => {
  const { login } = useApp();
  const [username, setUsername] = useState('admin@localqa.fixture');
  const [password, setPassword] = useState('AdminPass123!');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('请输入用户名或电子邮箱');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await login(username);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查账号密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 160px)',
        padding: '24px',
      }}
      data-testid="login-page"
    >
      <div
        className="card"
        style={{ maxWidth: '420px', width: '100%', padding: '32px' }}
      >
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              backgroundColor: 'var(--color-primary)',
              borderRadius: 'var(--radius-lg)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontWeight: 'bold',
              fontSize: '1.5rem',
              marginBottom: '12px',
            }}
          >
            L
          </div>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 700 }}>
            LocalQA 平台登录
          </h2>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              marginTop: '4px',
            }}
          >
            内网多用户自动化网页质量中台
          </p>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-danger-bg)',
              color: 'var(--color-danger-text)',
              border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.85rem',
              marginBottom: '16px',
            }}
            data-testid="login-error-message"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">账号 / 邮箱 (Username / Email)</label>
            <input
              type="text"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin@localqa.fixture"
              data-testid="login-username-input"
            />
          </div>

          <div className="form-group">
            <label className="form-label">登录密码 (Password)</label>
            <input
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              data-testid="login-password-input"
            />
          </div>

          <div
            style={{
              margin: '14px 0',
              fontSize: '0.75rem',
              color: 'var(--color-text-muted)',
              lineHeight: 1.5,
            }}
          >
            * 系统支持固定角色账号快速演示：
            <br />- 管理员: <code>admin@localqa.fixture</code>
            <br />- 操作员: <code>operator@localqa.fixture</code>
            <br />- 观察员: <code>viewer@localqa.fixture</code>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '8px' }}
            disabled={loading}
            data-testid="btn-login-submit"
          >
            {loading ? '正在验证凭据...' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
};
