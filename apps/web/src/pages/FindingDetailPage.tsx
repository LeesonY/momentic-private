import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import type { Finding } from '@localqa/contracts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { FindingEvidencePanel } from '../components/workbench/FindingEvidencePanel.tsx';
import { TriageModal } from '../components/workbench/TriageModal.tsx';

export const FindingDetailPage: React.FC = () => {
  const { routeParams, setRoute } = useApp();
  const findingId = routeParams.findingId || 'find_mock_01_calc_error';
  const runId = routeParams.runId || 'run_mock_001_completed';

  const [finding, setFinding] = useState<Finding | null>(null);
  const [loading, setLoading] = useState(true);
  const [isTriageOpen, setIsTriageOpen] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const f = await defaultApiClient.getFinding(findingId);
        setFinding(f);
      } catch (err) {
        console.warn('Failed to load finding:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [findingId]);

  if (loading) {
    return (
      <Page>
        <p>正在加载缺陷详情...</p>
      </Page>
    );
  }

  if (!finding) {
    return (
      <Page>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setRoute('workbench', { runId })}
        >
          ← 返回运行工作台
        </button>
        <div style={{ marginTop: '20px' }}>未找到指定缺陷记录。</div>
      </Page>
    );
  }

  return (
    <Page testId="finding-detail-page">
      <div style={{ marginBottom: '16px' }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setRoute('workbench', { runId })}
          data-testid="btn-back-workbench"
        >
          ← 返回运行工作台 ({runId})
        </button>
      </div>

      {/* Finding Header Card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-muted)',
              }}
            >
              缺陷编号: <code>{finding.id}</code>
            </span>
            <StatusBadge status={finding.status} />
            <span className="badge badge-neutral">
              类型: {finding.kind === 'functional' ? '功能缺陷' : '静态缺陷'}
            </span>
            <span className="badge badge-info">
              审查状态: {finding.triageDisposition}
            </span>
          </div>

          <button
            className="btn btn-primary btn-sm"
            onClick={() => setIsTriageOpen(true)}
            data-testid="btn-open-triage"
          >
            发起人工审查决议 (Triage) ⚖️
          </button>
        </div>

        <h1
          style={{
            fontSize: '1.4rem',
            fontWeight: 700,
            color: 'var(--color-danger-text)',
            marginBottom: '12px',
          }}
        >
          {finding.title}
        </h1>

        {/* Expected vs Actual Comparison Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            margin: '16px 0',
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--color-success-bg)',
              border: '1px solid var(--color-success-border)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}
          >
            <h4
              style={{
                fontSize: '0.9rem',
                fontWeight: 600,
                color: 'var(--color-success-text)',
                marginBottom: '6px',
              }}
            >
              预期行为与依据 (Expected):
            </h4>
            <p
              style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-main)',
                lineHeight: 1.5,
              }}
            >
              {finding.expected}
            </p>
          </div>

          <div
            style={{
              backgroundColor: 'var(--color-danger-bg)',
              border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}
          >
            <h4
              style={{
                fontSize: '0.9rem',
                fontWeight: 600,
                color: 'var(--color-danger-text)',
                marginBottom: '6px',
              }}
            >
              实际呈现行为 (Actual):
            </h4>
            <p
              style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-main)',
                lineHeight: 1.5,
              }}
            >
              {finding.actual}
            </p>
          </div>
        </div>
      </div>

      {/* Reproduction Steps */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div className="card-header">
          <h3 className="card-title">必要复现步骤 (Reproduction Steps)</h3>
          <span
            style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
          >
            独立 Reproducer 在全新干净上下文执行验证
          </span>
        </div>

        <ol
          style={{ paddingLeft: '24px', fontSize: '0.9rem', lineHeight: 1.8 }}
          data-testid="repro-steps-list"
        >
          {finding.reproSteps.map((step, idx) => (
            <li key={idx} style={{ color: 'var(--color-text-main)' }}>
              {step}
            </li>
          ))}
        </ol>
      </div>

      <FindingEvidencePanel finding={finding} />

      {/* Triage Modal */}
      <TriageModal
        finding={finding}
        isOpen={isTriageOpen}
        onClose={() => setIsTriageOpen(false)}
        onSuccess={(updated) => setFinding(updated)}
      />
    </Page>
  );
};
