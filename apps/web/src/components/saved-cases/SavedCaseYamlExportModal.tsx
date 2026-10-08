import React, { useState, useEffect } from 'react';
import type { SavedCaseYamlExport } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';

interface SavedCaseYamlExportModalProps {
  versionId: string;
  versionNum: number;
  caseSlug: string;
  isOpen: boolean;
  onClose: () => void;
}

export const SavedCaseYamlExportModal: React.FC<
  SavedCaseYamlExportModalProps
> = ({ versionId, versionNum, caseSlug, isOpen, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportData, setExportData] = useState<SavedCaseYamlExport | null>(
    null,
  );
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [copiedSha, setCopiedSha] = useState(false);

  useEffect(() => {
    if (!isOpen || !versionId) return;

    let mounted = true;
    setLoading(true);
    setError(null);
    setExportData(null);
    setCopiedYaml(false);
    setCopiedSha(false);

    defaultApiClient
      .exportSavedCaseYaml(versionId)
      .then((data) => {
        if (!mounted) return;
        if (data.versionId !== versionId) {
          throw new Error(
            `导出的版本与所选版本不一致: 预期 ${versionId}, 返回 ${data.versionId}`,
          );
        }
        setExportData(data);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : '导出 YAML 失败');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen, versionId]);

  if (!isOpen) return null;

  const handleCopyYaml = async () => {
    if (!exportData?.yaml) return;
    try {
      await navigator.clipboard.writeText(exportData.yaml);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleCopySha = async () => {
    if (!exportData?.sourceDocumentSha256) return;
    try {
      await navigator.clipboard.writeText(exportData.sourceDocumentSha256);
      setCopiedSha(true);
      setTimeout(() => setCopiedSha(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleDownload = () => {
    if (!exportData || exportData.versionId !== versionId || !exportData.yaml)
      return;
    const blob = new Blob([exportData.yaml], {
      type: 'text/yaml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${caseSlug || 'case'}-v${versionNum}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      data-testid="yaml-export-modal-overlay"
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '720px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--color-bg-surface, #ffffff)',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: 'var(--shadow-xl)',
          overflow: 'hidden',
        }}
        data-testid="yaml-export-modal"
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border-subtle, #e5e7eb)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 600 }}>
              📤 导出 YAML 测试用例
            </h2>
            <p
              style={{
                margin: '2px 0 0 0',
                fontSize: '0.8rem',
                color: 'var(--color-text-muted, #6b7280)',
              }}
            >
              绑定版本 <strong>v{versionNum}</strong> (含 SHA-256 校验码)
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            style={{ padding: '4px 8px', fontSize: '1rem', lineHeight: 1 }}
            data-testid="btn-close-yaml-export"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {loading && (
            <div
              style={{
                padding: '40px 0',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
              }}
              data-testid="yaml-export-loading"
            >
              正在从服务端加载版本 YAML 与 SHA 校验码...
            </div>
          )}

          {error && <ErrorCard message={error} />}

          {!loading && exportData && (
            <>
              {/* Immutable Version & Checksum Bar */}
              <div
                style={{
                  padding: '10px 14px',
                  backgroundColor: '#f3f4f6',
                  borderRadius: 'var(--radius-md, 6px)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  fontSize: '0.8rem',
                }}
                data-testid="yaml-export-metadata-bar"
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <span>
                    <strong>版本 ID:</strong>{' '}
                    <code style={{ fontSize: '0.78rem' }}>
                      {exportData.versionId}
                    </code>
                  </span>
                  <span>
                    <strong>用例标识:</strong> {caseSlug} (v{versionNum})
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span
                      style={{
                        backgroundColor: '#d1fae5',
                        color: '#065f46',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        fontWeight: 600,
                        fontSize: '0.72rem',
                      }}
                    >
                      SHA-256
                    </span>
                    <code
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '0.76rem',
                        wordBreak: 'break-all',
                      }}
                      data-testid="yaml-export-sha"
                    >
                      {exportData.sourceDocumentSha256}
                    </code>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                    onClick={handleCopySha}
                    data-testid="btn-copy-yaml-sha"
                  >
                    {copiedSha ? '✓ 已复制' : '复制哈希'}
                  </button>
                </div>
              </div>

              {/* Readonly YAML viewer */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '4px',
                  }}
                >
                  <label
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    YAML 规范代码
                  </label>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted, #6b7280)',
                      fontFamily: 'monospace',
                    }}
                  >
                    {exportData.yaml.length.toLocaleString()} 字符
                  </span>
                </div>
                <textarea
                  className="input"
                  readOnly
                  rows={14}
                  style={{
                    width: '100%',
                    fontFamily:
                      'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                    fontSize: '0.82rem',
                    lineHeight: 1.45,
                    tabSize: 2,
                    whiteSpace: 'pre',
                    backgroundColor: '#fafafa',
                  }}
                  value={exportData.yaml}
                  data-testid="textarea-exported-yaml"
                />
              </div>

              {/* Actions */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  borderTop: '1px solid var(--color-border-subtle, #e5e7eb)',
                  paddingTop: '16px',
                }}
              >
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleCopyYaml}
                    data-testid="btn-copy-yaml-content"
                  >
                    {copiedYaml ? '✓ 已复制到剪贴板' : '📋 复制 YAML'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleDownload}
                    data-testid="btn-download-yaml-file"
                  >
                    💾 下载 .yaml 文件
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onClose}
                  data-testid="btn-close-yaml-export-dialog"
                >
                  关闭
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
