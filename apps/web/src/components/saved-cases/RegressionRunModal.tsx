import React, { useState, useEffect } from 'react';
import type { Environment, AuthProfile, Run } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

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
    <Modal
      title="发起回归测试"
      description="使用已批准的基线版本回放用例，启动后自动跳转到运行工作台。"
      onClose={onClose}
      overlayTestId="regression-run-modal-overlay"
      testId="regression-run-modal-content"
      closeTestId="btn-close-regression-modal"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="regression-run-form"
            className="btn btn-primary"
            disabled={loading || fetchingOptions || selectedCases.length === 0}
            data-testid="btn-submit-regression-run"
          >
            <AppIcon name="play" size={13} />
            {loading ? '正在调度回归运行...' : '启动回归'}
          </button>
        </>
      }
    >
      {error && (
        <Alert
          tone="danger"
          testId="regression-modal-error"
          className="lqa-modal-alert"
        >
          {error}
        </Alert>
      )}

      {fetchingOptions ? (
        <div className="lqa-session-loading is-inline">
          正在加载项目环境与凭据配置...
        </div>
      ) : (
        <form id="regression-run-form" onSubmit={handleSubmit}>
          <Field label={`回归用例（${selectedCases.length} 个）`}>
            <div className="lqa-modal-list" data-testid="selected-cases-list">
              {selectedCases.map((c) => (
                <div key={c.versionId} className="lqa-modal-list-item">
                  <span className="truncate">{c.caseName}</span>
                  <span className="badge badge-success badge-sm">
                    v{c.versionNum} 已批准
                  </span>
                </div>
              ))}
            </div>
          </Field>

          <Field label="目标环境" required htmlFor="select-env">
            <select
              id="select-env"
              className="input"
              value={selectedEnvId}
              onChange={(e) => setSelectedEnvId(e.target.value)}
              required
              data-testid="select-regression-env"
            >
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}（{env.baseUrl}）
                </option>
              ))}
            </select>
          </Field>

          <Field label="认证凭据" optional htmlFor="select-auth">
            <select
              id="select-auth"
              className="input"
              value={selectedAuthId}
              onChange={(e) => setSelectedAuthId(e.target.value)}
              data-testid="select-regression-auth"
            >
              <option value="">不使用凭据（匿名访问）</option>
              {authProfiles.map((auth) => (
                <option key={auth.id} value={auth.id}>
                  {auth.name}（{auth.mode}）
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="最长执行时间（秒）"
            htmlFor="input-budget-seconds"
            hint="30–3600 秒。启动后跳转到运行工作台，实时查看判定、过程与报告。"
          >
            <input
              id="input-budget-seconds"
              type="number"
              min={30}
              max={3600}
              className="input"
              value={maxActiveSeconds}
              onChange={(e) => setMaxActiveSeconds(Number(e.target.value))}
              data-testid="input-regression-budget-seconds"
            />
          </Field>
        </form>
      )}
    </Modal>
  );
};
