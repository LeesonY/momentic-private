import React, { useState } from 'react';
import type { SavedCase } from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { ErrorCard } from '../ui/ErrorCard.tsx';
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
      data-testid="yaml-import-modal-overlay"
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '680px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--color-bg-surface, #ffffff)',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: 'var(--shadow-xl)',
          overflow: 'hidden',
        }}
        data-testid="yaml-import-modal"
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
              📥 导入 YAML 测试用例
            </h2>
            <p
              style={{
                margin: '2px 0 0 0',
                fontSize: '0.8rem',
                color: 'var(--color-text-muted, #6b7280)',
              }}
            >
              输入或上传 YAML 测试规范文本，创建初始草稿。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            style={{ padding: '4px 8px', fontSize: '1rem', lineHeight: 1 }}
            data-testid="btn-close-yaml-import"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: '20px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Draft Notice */}
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              borderRadius: 'var(--radius-md, 6px)',
              fontSize: '0.82rem',
              color: 'var(--color-warning-text)',
              lineHeight: 1.45,
            }}
            data-testid="yaml-import-safety-notice"
          >
            <strong>草稿说明：</strong>
            导入将创建初始草稿 (Draft v1，状态为 <code>draft</code>
            )。用例在通过审查前不会执行，亦不可用于回归测试。
          </div>

          {serverError && <ErrorCard message={serverError} />}

          {/* Slug & Name */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px',
            }}
          >
            <div>
              <label
                htmlFor="input-yaml-slug"
                style={{
                  display: 'block',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  marginBottom: '4px',
                }}
              >
                用例标识 (Slug){' '}
                <span style={{ color: 'var(--color-danger-text)' }}>*</span>
              </label>
              <input
                id="input-yaml-slug"
                type="text"
                className="input"
                style={{ width: '100%' }}
                placeholder="例如: checkout-payment-flow"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  if (validationErrors.slug) {
                    setValidationErrors((prev) => ({ ...prev, slug: '' }));
                  }
                }}
                data-testid="input-yaml-slug"
              />
              {validationErrors.slug && (
                <p
                  style={{
                    color: 'var(--color-danger-text)',
                    fontSize: '0.75rem',
                    margin: '4px 0 0 0',
                  }}
                >
                  {validationErrors.slug}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="input-yaml-name"
                style={{
                  display: 'block',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  marginBottom: '4px',
                }}
              >
                用例名称 (Name){' '}
                <span style={{ color: 'var(--color-danger-text)' }}>*</span>
              </label>
              <input
                id="input-yaml-name"
                type="text"
                className="input"
                style={{ width: '100%' }}
                placeholder="例如: 购物车结算付款流程"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (validationErrors.name) {
                    setValidationErrors((prev) => ({ ...prev, name: '' }));
                  }
                }}
                data-testid="input-yaml-name"
              />
              {validationErrors.name && (
                <p
                  style={{
                    color: 'var(--color-danger-text)',
                    fontSize: '0.75rem',
                    margin: '4px 0 0 0',
                  }}
                >
                  {validationErrors.name}
                </p>
              )}
            </div>
          </div>

          {/* YAML Textarea with Character & Byte Counter & File Upload */}
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '4px',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              <label
                htmlFor="input-yaml-content"
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                }}
              >
                YAML 测试用例文本{' '}
                <span style={{ color: 'var(--color-danger-text)' }}>*</span>
              </label>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                <label
                  className="btn btn-secondary"
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  data-testid="btn-upload-yaml-file"
                >
                  📁 选择本地文件 (.yaml)
                  <input
                    type="file"
                    accept=".yaml,.yml,text/yaml"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </label>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'monospace',
                    color: isOverLimit
                      ? 'var(--color-danger-text)'
                      : 'var(--color-text-muted, #6b7280)',
                    fontWeight: isOverLimit ? 700 : 400,
                  }}
                  data-testid="yaml-char-counter"
                >
                  {byteCount.toLocaleString()} / 262,144 字节 (
                  {charCount.toLocaleString()} 字符)
                  {isOverLimit &&
                    ` (超出 ${Math.max(byteCount - MAX_YAML_BYTES, charCount - MAX_YAML_CHARS).toLocaleString()})`}
                </span>
              </div>
            </div>

            <textarea
              id="input-yaml-content"
              className="input"
              rows={14}
              style={{
                width: '100%',
                fontFamily:
                  'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                fontSize: '0.82rem',
                lineHeight: 1.45,
                tabSize: 2,
                whiteSpace: 'pre',
                borderColor: isOverLimit
                  ? 'var(--color-danger-border)'
                  : undefined,
              }}
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
              <p
                style={{
                  color: 'var(--color-danger-text)',
                  fontSize: '0.75rem',
                  margin: '4px 0 0 0',
                }}
              >
                {validationErrors.yaml}
              </p>
            )}
          </div>

          {/* Footer Actions */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              borderTop: '1px solid var(--color-border-subtle, #e5e7eb)',
              paddingTop: '16px',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={loading}
              data-testid="btn-cancel-yaml-import"
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || isOverLimit}
              data-testid="btn-submit-yaml-import"
            >
              {loading ? '正在提交...' : '确认导入 (创建草稿)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
