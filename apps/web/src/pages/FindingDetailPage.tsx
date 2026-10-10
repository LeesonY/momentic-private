import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import type { Finding } from '@localqa/contracts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { Section } from '../components/ui/Section.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
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

  const back = {
    label: `返回运行工作台`,
    onClick: () => setRoute('workbench', { runId }),
    testId: 'btn-back-workbench',
  };

  if (loading) {
    return (
      <Page back={back}>
        <div className="lqa-session-loading is-inline">正在加载缺陷详情...</div>
      </Page>
    );
  }

  if (!finding) {
    return (
      <Page back={back}>
        <EmptyState icon="bug" title="未找到指定的缺陷记录" />
      </Page>
    );
  }

  return (
    <Page
      testId="finding-detail-page"
      back={back}
      eyebrow={
        <>
          <AppIcon name="bug" size={14} /> 缺陷 · <code>{finding.id}</code>
        </>
      }
      title={finding.title}
      actions={
        <button
          className="btn btn-primary"
          onClick={() => setIsTriageOpen(true)}
          data-testid="btn-open-triage"
        >
          <AppIcon name="flag" size={14} />
          人工审查决议
        </button>
      }
    >
      <div className="row row-wrap lqa-finding-badges">
        <StatusBadge status={finding.status} />
        <span className="badge badge-neutral">
          {finding.kind === 'functional' ? '功能缺陷' : '静态缺陷'}
        </span>
        <span className="badge badge-info">
          审查状态 {finding.triageDisposition}
        </span>
        <span className="subtle text-xs">所属运行 {runId}</span>
      </div>

      <div className="grid-2 lqa-compare">
        <div className="lqa-compare-box is-expected">
          <div className="lqa-compare-label">
            <AppIcon name="check-circle" size={15} />
            预期行为与依据
          </div>
          <p>{finding.expected}</p>
        </div>
        <div className="lqa-compare-box is-actual">
          <div className="lqa-compare-label">
            <AppIcon name="x-circle" size={15} />
            实际呈现
          </div>
          <p>{finding.actual}</p>
        </div>
      </div>

      <Section
        icon="list"
        title="复现步骤"
        description="由独立的 Reproducer 在全新、干净的浏览器上下文中验证。"
      >
        <ol className="lqa-steps" data-testid="repro-steps-list">
          {finding.reproSteps.map((step, idx) => (
            <li key={idx}>{step.replace(/^\s*\d+\s*[.、)）]\s*/, '')}</li>
          ))}
        </ol>
      </Section>

      <FindingEvidencePanel finding={finding} />

      <TriageModal
        finding={finding}
        isOpen={isTriageOpen}
        onClose={() => setIsTriageOpen(false)}
        onSuccess={(updated) => setFinding(updated)}
      />
    </Page>
  );
};
