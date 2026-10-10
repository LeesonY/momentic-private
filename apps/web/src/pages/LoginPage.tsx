import React, { useState } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { ThemeToggle } from '../components/ui/ThemeToggle.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';

export const LoginPage: React.FC = () => {
  const { login, isMock } = useApp();
  const [username, setUsername] = useState(
    isMock ? 'admin@localqa.fixture' : '',
  );
  const [password, setPassword] = useState(isMock ? 'AdminPass123!' : '');
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
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请检查账号密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="lqa-login-shell" data-testid="login-page">
      <div className="lqa-login-theme">
        <ThemeToggle />
      </div>
      <div className="card lqa-login-card">
        <div className="lqa-login-brand">
          <span className="lqa-brand-mark">
            <AppIcon name="layers" size={22} />
          </span>
          <div>
            <h1 className="lqa-login-title">登录 LocalQA</h1>
            <p className="muted text-sm">内网多人协作的自动化网页质量平台</p>
          </div>
        </div>

        {error && (
          <Alert
            tone="danger"
            testId="login-error-message"
            className="lqa-modal-alert"
          >
            {error}
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Field label="账号或邮箱" htmlFor="login-username">
            <input
              id="login-username"
              type="text"
              className="form-input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin@localqa.fixture"
              data-testid="login-username-input"
            />
          </Field>

          <Field label="密码" htmlFor="login-password">
            <input
              id="login-password"
              type="password"
              className="form-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              data-testid="login-password-input"
            />
          </Field>

          {isMock && (
            <div className="panel lqa-login-demo">
              <div className="section-label">演示账号</div>
              <dl className="kv">
                <dt>管理员</dt>
                <dd>
                  <code>admin@localqa.fixture</code>
                </dd>
                <dt>操作员</dt>
                <dd>
                  <code>operator@localqa.fixture</code>
                </dd>
                <dt>只读成员</dt>
                <dd>
                  <code>viewer@localqa.fixture</code>
                </dd>
              </dl>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            disabled={loading}
            data-testid="btn-login-submit"
          >
            {loading ? '正在验证凭据...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
};
