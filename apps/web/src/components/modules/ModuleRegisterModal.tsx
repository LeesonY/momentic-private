import React, { useState } from 'react';
import type {
  RegressionDocument,
  RegressionModuleRecord,
} from '@localqa/contracts';
import { validateContract } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';

interface ModuleRegisterModalProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onCreated: (record: RegressionModuleRecord) => void;
  existingModule?: {
    name: string;
    latestVersion: number;
    latestDocument: RegressionDocument;
  } | null;
}

const MODULE_NAME_PATTERN =
  /^(?!\.{1,2}(?:\/|$))(?!.*?\/\.{1,2}(?:\/|$))[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;

export const ModuleRegisterModal: React.FC<ModuleRegisterModalProps> = ({
  projectId,
  isOpen,
  onClose,
  onCreated,
  existingModule,
}) => {
  const isNewVersion = !!existingModule;
  const [name, setName] = useState(existingModule?.name || '');
  const [documentJson, setDocumentJson] = useState(() => {
    if (existingModule?.latestDocument) {
      return JSON.stringify(existingModule.latestDocument, null, 2);
    }
    const sampleDoc: RegressionDocument = {
      schemaVersion: 1,
      kind: 'localqa/test',
      id: 'custom-module',
      name: '自定义受控模块',
      variables: {},
      criteria: [
        {
          id: 'crit-01',
          kind: 'element_visible',
          description: '关键界面元素存在且可见',
          sourceKind: 'saved_case',
          sourceRef: 'custom-module',
          locator: { by: 'css', value: '#main' },
        },
      ],
      steps: [
        { kind: 'navigate', url: 'http://localhost:8080/' },
        { kind: 'assert', criterionId: 'crit-01' },
      ],
      fixtureRefs: [],
    };
    return JSON.stringify(sampleDoc, null, 2);
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('模块名称不能为空');
      return;
    }
    if (trimmedName.length > 120) {
      setError('模块名称长度不得超过 120 字符');
      return;
    }
    if (!MODULE_NAME_PATTERN.test(trimmedName)) {
      setError(
        '模块名称格式不合法: 仅支持字母、数字、下划线、点、破折号及正斜杠层级，不能以点开头或结尾',
      );
      return;
    }

    let parsedDoc: RegressionDocument;
    try {
      parsedDoc = JSON.parse(documentJson);
    } catch {
      setError('JSON 格式错误，请检查输入的 RegressionDocument JSON 格式');
      return;
    }

    // Canonical contract validation
    const valResult = validateContract('RegressionDocument', parsedDoc);
    if (!valResult.success) {
      const issues = valResult.errors?.map((err) => err.message).join('; ');
      setError(`用例文档不符合契约规范: ${issues}`);
      return;
    }

    try {
      setLoading(true);
      const record = await defaultApiClient.createRegressionModule(projectId, {
        name: trimmedName,
        document: parsedDoc,
        expectedVersion: isNewVersion
          ? existingModule.latestVersion
          : undefined,
      });
      onCreated(record);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      data-testid="module-register-modal"
    >
      <div
        className="card"
        style={{
          width: '90%',
          maxWidth: '680px',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
          }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>
            {isNewVersion
              ? `发布模块新版本: ${existingModule.name} (目标 v${existingModule.latestVersion + 1})`
              : '注册受控回归模块 (Register Module)'}
          </h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: '8px 12px',
            backgroundColor: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.8rem',
            color: 'var(--color-text-muted)',
            marginBottom: '16px',
          }}
        >
          ℹ️
          模块创建后初始状态为草稿（Draft）。草稿必须由项目所有者（Owner）进行两阶段审查批准后，方可作为受控基线在回归执行中引用。
        </div>

        {error && (
          <div
            className="card"
            style={{
              padding: '8px 12px',
              backgroundColor: '#fef2f2',
              borderColor: '#fecaca',
              color: '#dc2626',
              marginBottom: '16px',
              fontSize: '0.85rem',
            }}
            data-testid="module-register-error"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.85rem',
                marginBottom: '6px',
              }}
            >
              模块名称 (Module Name)
            </label>
            <input
              type="text"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isNewVersion || loading}
              placeholder="auth_helper 或 checkout/coupon"
              style={{ width: '100%' }}
              data-testid="module-name-input"
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.85rem',
                marginBottom: '6px',
              }}
            >
              用例文档内容 (RegressionDocument JSON)
            </label>
            <textarea
              className="form-input"
              rows={12}
              value={documentJson}
              onChange={(e) => setDocumentJson(e.target.value)}
              disabled={loading}
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                lineHeight: 1.4,
              }}
              data-testid="module-document-json-input"
            />
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              marginTop: '20px',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              data-testid="btn-submit-register-module"
            >
              {loading
                ? '提交中...'
                : isNewVersion
                  ? '提交新版本草稿'
                  : '提交注册草稿'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
