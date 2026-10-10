import React, { useState } from 'react';
import type { Export } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { downloadBlob } from '../../utils/downloadBlob.ts';

type ExportFormat = Export['format'];
const formats: { value: ExportFormat; label: string; extension: string }[] = [
  { value: 'json', label: 'JSON', extension: 'json' },
  { value: 'markdown', label: 'Markdown', extension: 'md' },
  { value: 'zip', label: 'ZIP（含证据清单）', extension: 'zip' },
];

export const ReportExportPanel: React.FC<{ runId: string }> = ({ runId }) => {
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<Export | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const validate = (item: Export, format: ExportFormat) => {
    if (item.runId !== runId || item.format !== format)
      throw new Error('返回的导出记录与当前运行不一致');
    if (item.status === 'failed')
      throw new Error(item.error || '服务器生成导出失败');
    return item;
  };

  const downloadReady = async (item: Export) => {
    if (item.status !== 'ready' || !item.artifactId)
      throw new Error('导出文件尚未就绪，不能下载');
    const blob = await defaultApiClient.downloadArtifact(item.artifactId);
    const extension = formats.find((f) => f.value === item.format)!.extension;
    downloadBlob(
      blob,
      `localqa-${runId.slice(0, 8)}-${item.id.slice(0, 8)}.${extension}`,
    );
    setNotice(`已下载 ${item.format.toUpperCase()} 报告（${blob.size} 字节）`);
  };

  const start = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setRecord(null);
    try {
      const item = validate(
        await defaultApiClient.createExport(runId, {
          format,
          includeArtifacts: format === 'zip',
        }),
        format,
      );
      setRecord(item);
      if (item.status === 'ready') await downloadReady(item);
      else setNotice('服务器正在生成文件，可点击“检查导出状态”。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (busy || !record) return;
    setBusy(true);
    setError('');
    try {
      const current = validate(
        await defaultApiClient.getExport(record.id),
        record.format,
      );
      if (current.id !== record.id)
        throw new Error('服务器返回了不匹配的导出记录');
      setRecord(current);
      if (current.status === 'ready') await downloadReady(current);
      else setNotice(`导出仍处于 ${current.status} 状态，稍后再检查。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '查询导出状态失败');
    } finally {
      setBusy(false);
    }
  };

  const retryDownload = async () => {
    if (busy || !record) return;
    setBusy(true);
    setError('');
    try {
      await downloadReady(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack stack-sm" data-testid="report-export-panel">
      <div className="section-label lqa-flush-label">导出运行报告</div>
      <div className="btn-group">
        {formats.map((format) => (
          <button
            key={format.value}
            className="btn btn-secondary btn-sm"
            type="button"
            data-testid={`btn-export-${format.value}`}
            disabled={busy}
            onClick={() => void start(format.value)}
          >
            {busy ? '处理中…' : `下载 ${format.label}`}
          </button>
        ))}
      </div>
      {record && (
        <p className="text-xs muted" data-testid="export-record">
          格式 {record.format} · 状态 {record.status} · 导出 ID{' '}
          <code>{record.id}</code>
        </p>
      )}
      {record &&
        (record.status === 'queued' || record.status === 'running') && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="btn-refresh-export"
            onClick={() => void refresh()}
            disabled={busy}
          >
            检查导出状态
          </button>
        )}
      {record?.status === 'ready' && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="btn-retry-export-download"
          onClick={() => void retryDownload()}
          disabled={busy}
        >
          重新下载文件
        </button>
      )}
      {notice && (
        <p
          className="text-sm text-success"
          role="status"
          data-testid="export-notice-message"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          className="text-sm text-danger"
          role="alert"
          data-testid="export-error-message"
        >
          {error}
        </p>
      )}
    </section>
  );
};
