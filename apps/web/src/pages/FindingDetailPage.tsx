import React, { useState, useEffect } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import type { Finding } from '@localqa/contracts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { Section } from '../components/ui/Section.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { FindingEvidencePanel } from '../components/workbench/FindingEvidencePanel.tsx';
import { RecordingPlayer } from '../components/recording/RecordingPlayer.tsx';
import { useTaskRecording } from '../components/recording/useTaskRecording.ts';
import { TriageModal } from '../components/workbench/TriageModal.tsx';
import {
  findingDuplicateOf,
  isDuplicateFinding,
} from '../components/session/findingDedup.ts';

/** Older findings carry no reproduction recording (`Finding.recording`). */
const recordingOf = (finding: Finding) =>
  finding.recording && typeof finding.recording.taskId === 'string'
    ? finding.recording
    : null;

export const FindingDetailPage: React.FC = () => {
  const { routeParams, setRoute } = useApp();
  const findingId = routeParams.findingId || 'find_mock_01_calc_error';
  const runId = routeParams.runId || 'run_mock_001_completed';

  const [finding, setFinding] = useState<Finding | null>(null);
  const recording = finding ? recordingOf(finding) : null;
  // Repro recorder only exists for a confirmed reproduction; a static defect
  // keeps its screenshots and never pretends to have a replay.
  const replay = useTaskRecording(
    recording?.taskId ?? null,
    Boolean(recording) && finding?.kind === 'functional',
    runId,
  );
  const [retainedTarget, setRetainedTarget] = useState<Finding | null>(null);
  const [loading, setLoading] = useState(true);
  const [isTriageOpen, setIsTriageOpen] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setRetainedTarget(null);
      try {
        const f = await defaultApiClient.getFinding(findingId);
        setFinding(f);
        // Newer backends point a merged finding at the retained one; load
        // it for the banner link when it is a different record.
        const targetId = findingDuplicateOf(f);
        if (targetId && targetId !== f.id) {
          const target = await defaultApiClient
            .getFinding(targetId)
            .catch(() => null);
          if (target?.id === targetId) setRetainedTarget(target);
        }
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
        {isDuplicateFinding(finding) && (
          <span
            className="badge badge-neutral"
            data-testid="badge-finding-duplicate"
          >
            已合并的重复报告
          </span>
        )}
        <span className="subtle text-xs">所属运行 {runId}</span>
      </div>

      {isDuplicateFinding(finding) && (
        <Alert tone="info" testId="finding-duplicate-banner">
          这条报告与
          {retainedTarget ? (
            <>
              {' '}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setRoute('finding-detail', {
                    findingId: retainedTarget.id,
                    runId,
                  })
                }
                data-testid="btn-open-retained-finding"
              >
                {retainedTarget.title}
                <AppIcon name="arrow-right" size={12} />
              </button>{' '}
            </>
          ) : (
            ' 另一条报告 '
          )}
          是同一个问题，已合并；后续统计与列表都以保留的那条为准。
        </Alert>
      )}

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
        actions={
          <span className="row row-wrap lqa-finding-links">
            {finding.caseIds[0] && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setRoute('case-detail', {
                    caseId: finding.caseIds[0]!,
                    runId,
                  })
                }
                data-testid="btn-finding-case"
              >
                发现于
                <AppIcon name="arrow-right" size={12} />
              </button>
            )}
            {recording && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  setRoute('workbench', {
                    runId,
                    tab: 'screen',
                    taskId: recording.taskId,
                  })
                }
                data-testid="btn-finding-reproducer"
              >
                复现代理
                <AppIcon name="arrow-right" size={12} />
              </button>
            )}
          </span>
        }
      >
        <ol className="lqa-steps" data-testid="repro-steps-list">
          {finding.reproSteps.map((step, idx) => (
            <li key={idx}>{step.replace(/^\s*\d+\s*[.、)）]\s*/, '')}</li>
          ))}
        </ol>
      </Section>

      {recording && finding.kind === 'functional' && (
        <Section
          icon="play"
          title="复现"
          description="复现代理在干净浏览器里重新跑出的那一段，可拖动、逐条复现步骤跳转。"
          testId="finding-reproduction"
        >
          {replay.loading && (
            <p
              className="field-hint"
              data-testid="finding-reproduction-loading"
            >
              正在读取复现录像…
            </p>
          )}
          {!replay.loading && replay.error && (
            <Alert tone="danger" testId="finding-reproduction-error">
              {replay.error}
            </Alert>
          )}
          {!replay.loading && replay.playable && replay.recording && (
            <RecordingPlayer
              heading="复现"
              testId="finding-recording-player"
              recording={replay.recording}
              events={replay.payload?.events ?? []}
              consoleLines={replay.payload?.consoleLines ?? []}
              networkLines={replay.payload?.networkLines ?? []}
              warnings={replay.warnings}
              steps={replay.steps}
              window={{
                startAt: recording.startedAt,
                endAt: recording.endedAt,
              }}
              reproSteps={finding.reproSteps}
              reproMarks={recording.steps}
              onOpenFullRecording={() =>
                setRoute('workbench', {
                  runId,
                  tab: 'screen',
                  taskId: recording.taskId,
                })
              }
            />
          )}
          {!replay.loading &&
            !replay.error &&
            !replay.playable &&
            replay.recording && (
              <Alert tone="info" testId="finding-reproduction-missing">
                {replay.recording.status === 'recording'
                  ? '复现代理还在录制中，任务结束后可以回放。'
                  : (replay.recording.error ??
                    '这个复现任务没有可回放的录像，请看下面的关联证据。')}
              </Alert>
            )}
          {!replay.loading && !replay.error && !replay.recording && (
            <Alert tone="info" testId="finding-reproduction-missing">
              这个复现任务没有可回放的录像，请看下面的关联证据。
            </Alert>
          )}
        </Section>
      )}

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
