import React, { useState } from 'react';
import type { SavedCase } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';
import {
  validateYamlImportInput,
  getUtf8ByteLength,
  MAX_YAML_BYTES,
  MAX_YAML_CHARS,
} from '../../utils/yamlValidation.ts';

interface SavedCaseYamlImportModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (createdCase: SavedCase) => void;
}

export const SavedCaseYamlImportModal: React.FC<
  SavedCaseYamlImportModalProps
> = ({ projectId, isOpen, onClose, onSuccess }) => {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [yamlContent, setYamlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  if (!isOpen) return null;

  const byteCount = getUtf8ByteLength(yamlContent);
  const charCount = yamlContent.length;
  const isByteOverLimit = byteCount > MAX_YAML_BYTES;
  const isCharOverLimit = charCount > MAX_YAML_CHARS;
  const isOverLimit = isByteOverLimit || isCharOverLimit;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Pre-check file size before reading into memory to reject >256 KiB files early
    if (file.size > MAX_YAML_BYTES) {
      setValidationErrors((prev) => ({
        ...prev,
        yaml: `文件大小 (${file.size.toLocaleString()} 字节) 超出 256 KiB (262,144 字节) 限制，读取前已拒绝`,
      }));
      e.target.value = '';
      return;
    }

    // Auto-fill slug & name if empty
    const baseName = file.name.replace(/\.(yaml|yml)$/i, '');
    if (!slug.trim()) {
      const sanitizedSlug = baseName
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, 120);
      setSlug(sanitizedSlug);
    }
    if (!name.trim()) {
      setName(baseName.slice(0, 200));
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === 'string') {
        setYamlContent(text);
        if (validationErrors.yaml) {
          setValidationErrors((prev) => ({ ...prev, yaml: '' }));
        }
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const validateForm = (): boolean => {
    const validation = validateYamlImportInput({
      slug,
      name,
      yaml: yamlContent,
    });
    setValidationErrors(validation.errors);
    return validation.valid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validateForm()) return;

    setLoading(true);
    try {
      const created = await defaultApiClient.importSavedCaseYaml(projectId, {
        slug: slug.trim(),
        name: name.trim(),
        yaml: yamlContent,
      });
      onSuccess(created);
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : '导入 YAML 用例失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="导入 YAML 用例"
      description="粘贴或上传 YAML 测试规范，创建初始草稿。"
      onClose={onClose}
      size="lg"
      closeOnOverlay={false}
      overlayTestId="yaml-import-modal-overlay"
      testId="yaml-import-modal"
      closeTestId="btn-close-yaml-import"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={loading}
            data-testid="btn-cancel-yaml-import"
          >
            取消
          </button>
          <button
            type="submit"
            form="yaml-import-form"
            className="btn btn-primary"
            disabled={loading || isOverLimit}
            data-testid="btn-submit-yaml-import"
          >
            {loading ? '正在提交...' : '导入为草稿'}
          </button>
        </>
      }
    >
      <form id="yaml-import-form" onSubmit={handleSubmit} className="stack">
        <Alert
          tone="warning"
          title="导入后为草稿"
          testId="yaml-import-safety-notice"
        >
          将创建 v1 草稿（<code>draft</code>
          ），通过审查之前不会执行，也不能用于回归测试。
        </Alert>

        {serverError && <ErrorCard message={serverError} />}

        <div className="grid-2">
          <div className="field">
            <label className="field-label" htmlFor="input-yaml-slug">
              用例标识（Slug）<span className="field-required">*</span>
            </label>
            <input
              id="input-yaml-slug"
              type="text"
              className="input is-mono"
              placeholder="例如 checkout-payment-flow"
              value={slug}
              aria-invalid={!!validationErrors.slug}
              onChange={(e) => {
                setSlug(e.target.value);
                if (validationErrors.slug) {
                  setValidationErrors((prev) => ({ ...prev, slug: '' }));
                }
              }}
              data-testid="input-yaml-slug"
            />
            {validationErrors.slug && (
              <p className="field-error">{validationErrors.slug}</p>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="input-yaml-name">
              用例名称<span className="field-required">*</span>
            </label>
            <input
              id="input-yaml-name"
              type="text"
              className="input"
              placeholder="例如 购物车结算付款流程"
              value={name}
              aria-invalid={!!validationErrors.name}
              onChange={(e) => {
                setName(e.target.value);
                if (validationErrors.name) {
                  setValidationErrors((prev) => ({ ...prev, name: '' }));
                }
              }}
              data-testid="input-yaml-name"
            />
            {validationErrors.name && (
              <p className="field-error">{validationErrors.name}</p>
            )}
          </div>
        </div>

        <div className="field">
          <div className="row row-wrap spread">
            <label className="field-label" htmlFor="input-yaml-content">
              YAML 内容<span className="field-required">*</span>
            </label>
            <div className="row">
              <label
                className="btn btn-ghost btn-sm"
                data-testid="btn-upload-yaml-file"
              >
                <AppIcon name="upload" size={13} />
                选择本地文件
                <input
                  type="file"
                  accept=".yaml,.yml,text/yaml"
                  onChange={handleFileUpload}
                  className="sr-only"
                />
              </label>
              <span
                className={`text-xs mono ${isOverLimit ? 'text-danger strong' : 'subtle'}`}
                data-testid="yaml-char-counter"
              >
                {byteCount.toLocaleString()} / 262,144 字节（
                {charCount.toLocaleString()} 字符）
                {isOverLimit &&
                  `，超出 ${Math.max(byteCount - MAX_YAML_BYTES, charCount - MAX_YAML_CHARS).toLocaleString()}`}
              </span>
            </div>
          </div>

          <textarea
            id="input-yaml-content"
            className="input is-mono lqa-code-area"
            rows={14}
            aria-invalid={isOverLimit || !!validationErrors.yaml}
            placeholder={`schemaVersion: 1\nkind: localqa/test\nid: sample-test\nname: 示例用例\nsteps:\n  - kind: navigate\n    url: https://example.com\n`}
            value={yamlContent}
            onChange={(e) => {
              setYamlContent(e.target.value);
              if (validationErrors.yaml) {
                setValidationErrors((prev) => ({ ...prev, yaml: '' }));
              }
            }}
            data-testid="input-yaml-content"
          />
          {validationErrors.yaml && (
            <p className="field-error">{validationErrors.yaml}</p>
          )}
        </div>
      </form>
    </Modal>
  );
};
