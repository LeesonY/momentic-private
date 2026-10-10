import React, { useState, useEffect } from 'react';
import type { SavedCaseYamlExport } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

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
    <Modal
      title="导出 YAML"
      description={
        <>
          绑定版本 <strong>v{versionNum}</strong>，附带 SHA-256 校验码。
        </>
      }
      onClose={onClose}
      size="lg"
      closeOnOverlay={false}
      overlayTestId="yaml-export-modal-overlay"
      testId="yaml-export-modal"
      closeTestId="btn-close-yaml-export"
      footer={
        <>
          {!loading && exportData && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCopyYaml}
                data-testid="btn-copy-yaml-content"
              >
                <AppIcon name={copiedYaml ? 'check' : 'copy'} size={14} />
                {copiedYaml ? '已复制' : '复制 YAML'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleDownload}
                data-testid="btn-download-yaml-file"
              >
                <AppIcon name="download" size={14} />
                下载 .yaml 文件
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            data-testid="btn-close-yaml-export-dialog"
          >
            关闭
          </button>
        </>
      }
    >
      <div className="stack">
        {loading && (
          <div
            className="lqa-session-loading is-inline"
            data-testid="yaml-export-loading"
          >
            正在从服务端加载版本 YAML 与 SHA 校验码...
          </div>
        )}

        {error && <ErrorCard message={error} />}

        {!loading && exportData && (
          <>
            <div
              className="panel stack stack-xs"
              data-testid="yaml-export-metadata-bar"
            >
              <dl className="kv">
                <dt>版本 ID</dt>
                <dd>
                  <code>{exportData.versionId}</code>
                </dd>
                <dt>用例标识</dt>
                <dd>
                  {caseSlug}（v{versionNum}）
                </dd>
                <dt>SHA-256</dt>
                <dd className="row row-top">
                  <code
                    className="break-all grow"
                    data-testid="yaml-export-sha"
                  >
                    {exportData.sourceDocumentSha256}
                  </code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={handleCopySha}
                    data-testid="btn-copy-yaml-sha"
                  >
                    {copiedSha ? '已复制' : '复制'}
                  </button>
                </dd>
              </dl>
            </div>

            <div className="field">
              <div className="row spread">
                <label className="field-label" htmlFor="exported-yaml">
                  YAML
                </label>
                <span className="text-xs subtle mono">
                  {exportData.yaml.length.toLocaleString()} 字符
                </span>
              </div>
              <textarea
                id="exported-yaml"
                className="input is-mono lqa-code-area"
                readOnly
                rows={14}
                value={exportData.yaml}
                data-testid="textarea-exported-yaml"
              />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
