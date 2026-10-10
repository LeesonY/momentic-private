import React, { useEffect, useRef, useState } from 'react';
import type { Artifact, Finding } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { downloadBlob } from '../../utils/downloadBlob.ts';
import { useApp } from '../../state/AppContext.tsx';

type EvidenceRow = { artifact?: Artifact; error?: string };

export const FindingEvidencePanel: React.FC<{ finding: Finding }> = ({
  finding,
}) => {
  const { currentProject } = useApp();
  const [rows, setRows] = useState<Record<string, EvidenceRow>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(
    null,
  );
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows({});
    setLoading(finding.evidenceRefs.length > 0);
    setError('');
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
    void Promise.all(
      finding.evidenceRefs.map(async (id) => {
        try {
          const artifact = await defaultApiClient.getArtifact(id);
          if (
            artifact.id !== id ||
            artifact.runId !== finding.runId ||
            (currentProject && artifact.projectId !== currentProject.id)
          )
            throw new Error('证据不属于当前运行或项目');
          return [id, { artifact }] as const;
        } catch (err) {
          return [
            id,
            {
              error: err instanceof Error ? err.message : '无法读取证据元数据',
            },
          ] as const;
        }
      }),
    ).then((result) => {
      if (!cancelled) {
        setRows(Object.fromEntries(result));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    };
  }, [
    finding.id,
    finding.runId,
    finding.evidenceRefs.join(','),
    currentProject?.id,
  ]);

  const fetchBytes = async (artifact: Artifact) => {
    if (artifact.status !== 'available' || artifact.redaction === 'failed')
      throw new Error('该证据不可用或脱敏失败，禁止下载');
    if (artifact.runId !== finding.runId) throw new Error('证据不属于当前运行');
    if (currentProject && artifact.projectId !== currentProject.id)
      throw new Error('证据不属于当前项目');
    const blob = await defaultApiClient.downloadArtifact(artifact.id);
    if (!blob.size) throw new Error('证据内容为空');
    return blob;
  };

  const save = async (artifact: Artifact) => {
    if (busyId) return;
    setBusyId(artifact.id);
    setError('');
    try {
      const blob = await fetchBytes(artifact);
      const extension =
        artifact.kind === 'screenshot'
          ? 'png'
          : artifact.kind === 'network' || artifact.kind === 'console'
            ? 'json'
            : 'bin';
      downloadBlob(blob, `localqa-evidence-${artifact.id}.${extension}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载证据失败');
    } finally {
      setBusyId(null);
    }
  };

  const show = async (artifact: Artifact) => {
    if (busyId || artifact.kind !== 'screenshot') return;
    setBusyId(artifact.id);
    setError('');
    try {
      const blob = await fetchBytes(artifact);
      if (blob.type !== 'image/png')
        throw new Error('截图内容类型不是 image/png，已阻止预览');
      const url = URL.createObjectURL(blob);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = url;
      setPreview({ id: artifact.id, url });
    } catch (err) {
      setError(err instanceof Error ? err.message : '截图预览失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card" data-testid="evidence-section">
      <div className="card-header">
        <h3 className="card-title">
          关联证据
          <span className="badge badge-neutral badge-sm">
            {finding.evidenceRefs.length}
          </span>
        </h3>
      </div>
      {finding.evidenceRefs.length === 0 && (
        <p className="muted text-sm" data-testid="no-evidence">
          该缺陷没有关联证据引用。
        </p>
      )}
      {loading && (
        <p className="muted text-sm" data-testid="evidence-loading">
          正在核对证据元数据…
        </p>
      )}
      <div className="list">
        {finding.evidenceRefs.map((id) => {
          const row = rows[id];
          return (
            <div
              key={id}
              className="lqa-evidence-row"
              data-testid={`evidence-row-${id}`}
            >
              <code>{id}</code>
              {!loading && row?.error && (
                <p
                  className="text-sm text-danger"
                  role="alert"
                  data-testid={`evidence-error-${id}`}
                >
                  无法查看证据：{row.error}
                </p>
              )}
              {row?.artifact && (
                <>
                  <p className="text-xs muted break-all">
                    类型 {row.artifact.kind} · 状态 {row.artifact.status} · 脱敏{' '}
                    {row.artifact.redaction} · SHA-256{' '}
                    {row.artifact.sha256 ?? '未知'}
                  </p>
                  {row.artifact.status === 'available' &&
                    row.artifact.redaction !== 'failed' && (
                      <div className="btn-group">
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          data-testid={`btn-download-evidence-${id}`}
                          disabled={busyId !== null}
                          onClick={() => void save(row.artifact!)}
                        >
                          下载证据
                        </button>
                        {row.artifact.kind === 'screenshot' && (
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            data-testid={`btn-preview-evidence-${id}`}
                            disabled={busyId !== null}
                            onClick={() => void show(row.artifact!)}
                          >
                            预览截图
                          </button>
                        )}
                      </div>
                    )}
                  {(row.artifact.status !== 'available' ||
                    row.artifact.redaction === 'failed') && (
                    <p
                      className="text-sm text-warning"
                      data-testid={`evidence-unavailable-${id}`}
                    >
                      证据不可用，不会被当作已成功采集展示。
                    </p>
                  )}
                </>
              )}
              {preview?.id === id && (
                <img
                  src={preview.url}
                  alt="经过认证下载的缺陷现场截图"
                  className="lqa-evidence-image"
                  data-testid="evidence-screenshot"
                />
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p
          className="text-sm text-danger"
          role="alert"
          data-testid="evidence-action-error"
        >
          {error}
        </p>
      )}
    </section>
  );
};
