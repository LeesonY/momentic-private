import React, { useState, useEffect } from 'react';
import type { Environment, AuthProfile, Run } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';

interface SelectedCaseVersion {
  caseId: string;
  caseName: string;
  versionId: string;
  versionNum: number;
}

interface RegressionRunModalProps {
  projectId: string;
  selectedCases: SelectedCaseVersion[];
  isOpen: boolean;
  onClose: () => void;
  onStarted: (run: Run) => void;
}

export const RegressionRunModal: React.FC<RegressionRunModalProps> = ({
  projectId,
  selectedCases,
  isOpen,
  onClose,
  onStarted,
}) => {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [selectedAuthId, setSelectedAuthId] = useState<string>('');
  const [maxActiveSeconds, setMaxActiveSeconds] = useState<number>(300);
  const [loading, setLoading] = useState(false);
  const [fetchingOptions, setFetchingOptions] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !projectId) return;

    let mounted = true;
    setFetchingOptions(true);
    setError(null);

    Promise.all([
      defaultApiClient.listEnvironments(projectId).catch(() => ({ items: [] })),
      defaultApiClient.listAuthProfiles(projectId).catch(() => ({ items: [] })),
    ])
      .then(([envRes, authRes]) => {
        if (!mounted) return;
        setEnvironments(envRes.items);
        setAuthProfiles(authRes.items);
        if (envRes.items.length > 0) {
          setSelectedEnvId(envRes.items[0].id);
        }
      })
      .finally(() => {
        if (mounted) setFetchingOptions(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEnvId) {
      setError('请选择目标执行环境');
      return;
    }
    if (selectedCases.length === 0) {
      setError('请至少选择一个已批准的有效用例版本进行回归重跑');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const caseVersionIds = selectedCases.map((c) => c.versionId) as [
        string,
        ...string[],
      ];
      const run = await defaultApiClient.createRegressionRun({
        projectId,
        caseVersionIds,
        environmentId: selectedEnvId,
        authProfileId: selectedAuthId || undefined,
        budget: maxActiveSeconds ? { maxActiveSeconds } : undefined,
      });

      onStarted(run);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动回归运行失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      data-testid="regression-run-modal-overlay"
    >
      <div
        className="dialog-content"
        style={{ maxWidth: '600px', width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="regression-run-modal-content"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
            borderBottom: '1px solid var(--color-border-subtle)',
            paddingBottom: '12px',
          }}
        >
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
            发起自动化回归测试 (Launch Regression Run)
          </h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="btn-close-regression-modal"
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: '#fee2e2',
              border: '1px solid #f87171',
              borderRadius: 'var(--radius-md)',
              color: '#991b1b',
              marginBottom: '16px',
              fontSize: '0.85rem',
            }}
            data-testid="regression-modal-error"
          >
            {error}
          </div>
        )}

        {fetchingOptions ? (
          <div
            style={{
              padding: '24px 0',
              textAlign: 'center',
              color: 'var(--color-text-muted)',
            }}
          >
            正在加载项目环境与凭据配置...
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {/* Selected Cases List */}
            <div style={{ marginBottom: '16px' }}>
              <label
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '6px',
                }}
              >
                已选回归用例版本基准 ({selectedCases.length} 个)
              </label>
              <div
                style={{
                  backgroundColor: 'var(--color-bg-base)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  maxHeight: '130px',
                  overflowY: 'auto',
                  padding: '8px 12px',
                  fontSize: '0.85rem',
                }}
                data-testid="selected-cases-list"
              >
                {selectedCases.map((c) => (
                  <div
                    key={c.versionId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '4px 0',
                      borderBottom: '1px dashed var(--color-border-subtle)',
                    }}
                  >
                    <span>{c.caseName}</span>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        backgroundColor: '#d1fae5',
                        color: '#065f46',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-sm)',
                        fontWeight: 600,
                      }}
                    >
                      v{c.versionNum} (已批准)
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Target Environment */}
            <div style={{ marginBottom: '14px' }}>
              <label
                htmlFor="select-env"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '4px',
                }}
              >
                目标测试环境 (Environment){' '}
                <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <select
                id="select-env"
                className="input"
                style={{ width: '100%' }}
                value={selectedEnvId}
                onChange={(e) => setSelectedEnvId(e.target.value)}
                required
                data-testid="select-regression-env"
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.baseUrl})
                  </option>
                ))}
              </select>
            </div>

            {/* Auth Profile */}
            <div style={{ marginBottom: '14px' }}>
              <label
                htmlFor="select-auth"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '4px',
                }}
              >
                登录认证凭据 (Auth Profile, 可选)
              </label>
              <select
                id="select-auth"
                className="input"
                style={{ width: '100%' }}
                value={selectedAuthId}
                onChange={(e) => setSelectedAuthId(e.target.value)}
                data-testid="select-regression-auth"
              >
                <option value="">(无凭据 / 匿名测试)</option>
                {authProfiles.map((auth) => (
                  <option key={auth.id} value={auth.id}>
                    {auth.name} ({auth.mode})
                  </option>
                ))}
              </select>
            </div>

            {/* Budget Limit */}
            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="input-budget-seconds"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '4px',
                }}
              >
                最大执行耗时预算 (秒)
              </label>
              <input
                id="input-budget-seconds"
                type="number"
                min={30}
                max={3600}
                className="input"
                style={{ width: '100%' }}
                value={maxActiveSeconds}
                onChange={(e) => setMaxActiveSeconds(Number(e.target.value))}
                data-testid="input-regression-budget-seconds"
              />
              <p
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--color-text-muted)',
                  margin: '4px 0 0 0',
                }}
              >
                启动后将自动跳转至运行工作台，复用现有工作台进行实时判定、流式追踪与报告生成。
              </p>
            </div>

            {/* Footer */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                borderTop: '1px solid var(--color-border-subtle)',
                paddingTop: '16px',
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                取消
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || selectedCases.length === 0}
                data-testid="btn-submit-regression-run"
              >
                {loading
                  ? '正在调度回归运行...'
                  : '🚀 启动回归测试并跳转工作台'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
