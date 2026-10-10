import React, { useState } from 'react';
import type {
  CaseRecord,
  Step,
  SavedCase,
  RegressionDocument,
  Criterion,
  ReplayStep,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';

interface SaveToLibraryModalProps {
  sourceCase?: CaseRecord;
  caseRecord?: CaseRecord;
  sourceSteps?: Step[];
  steps?: Step[];
  projectId: string;
  isOpen?: boolean;
  onClose: () => void;
  onSuccess?: (savedCase: SavedCase) => void;
  onSaved?: (savedCase: SavedCase) => void;
}

export const SaveToLibraryModal: React.FC<SaveToLibraryModalProps> = ({
  sourceCase,
  caseRecord,
  sourceSteps,
  steps: passedSteps,
  projectId,
  isOpen = true,
  onClose,
  onSuccess,
  onSaved,
}) => {
  const cRecord = sourceCase || caseRecord;
  const rawSteps = sourceSteps || passedSteps || [];

  if (!isOpen || !cRecord) return null;

  const initialTitle = cRecord.definition?.title || '从冒烟测试提取的用例';
  const initialId = cRecord.definition?.id || 'smoke-case';
  const defaultSlug =
    initialTitle
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || `case-${initialId.slice(0, 8)}`;

  const [slug, setSlug] = useState(defaultSlug);
  const [name, setName] = useState(initialTitle);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim()) {
      setError('请输入用例唯一标识 (slug)');
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(slug)) {
      setError('slug 仅允许英文字母、数字、下划线、中划线与点号');
      return;
    }
    if (!name.trim()) {
      setError('请输入用例名称');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Build initial criteria from sourceCase criteria if present or fallback
      const rawCriteria = cRecord.definition?.criteria || [];
      const criteria: [Criterion, ...Criterion[]] =
        rawCriteria.length > 0
          ? (rawCriteria.map((c: Criterion, i: number) => ({
              id: c.id || `crit-${i + 1}`,
              kind: c.kind || 'element_visible',
              description: c.description || '准则校验',
              sourceKind: 'saved_case' as const,
              sourceRef: slug,
              locator: c.locator || { by: 'css' as const, value: 'body' },
              ...(c.expectedValue !== undefined
                ? { expectedValue: c.expectedValue }
                : {}),
            })) as [Criterion, ...Criterion[]])
          : [
              {
                id: 'crit-smoke-01',
                kind: 'element_visible',
                description: '页面主内容区域渲染成功且无崩溃报错',
                sourceKind: 'saved_case',
                sourceRef: slug,
                locator: { by: 'css', value: 'main, #app, #root, body' },
              },
            ];

      // Build initial steps from rawSteps or minimal replay
      const steps: [ReplayStep, ...ReplayStep[]] =
        rawSteps.length > 0
          ? (rawSteps.map((st: Step) => {
              if (st.toolName === 'navigate') {
                return {
                  kind: 'navigate' as const,
                  url: st.targetDescription || 'http://localhost:8080/',
                };
              }
              if (st.toolName === 'click') {
                return {
                  kind: 'click' as const,
                  locator: {
                    by: 'css' as const,
                    value: st.targetDescription || 'button',
                  },
                };
              }
              if (st.toolName === 'type_text' || st.toolName === 'fill') {
                return {
                  kind: 'type_text' as const,
                  locator: {
                    by: 'css' as const,
                    value: st.targetDescription || 'input',
                  },
                  text: st.summary || '',
                };
              }
              return {
                kind: 'assert' as const,
                criterionId: criteria[0].id,
              };
            }) as [ReplayStep, ...ReplayStep[]])
          : [
              { kind: 'navigate', url: 'http://localhost:8080/' },
              { kind: 'assert', criterionId: criteria[0].id },
            ];

      const document: RegressionDocument = {
        schemaVersion: 1,
        kind: 'localqa/test',
        id: slug,
        name: name.trim(),
        variables: {},
        criteria,
        steps,
        fixtureRefs: [],
      };

      const newSavedCase = await defaultApiClient.createSavedCase(projectId, {
        slug: slug.trim(),
        name: name.trim(),
        sourceRunCaseId: cRecord.definition?.id,
        document,
      });

      if (onSuccess) onSuccess(newSavedCase);
      if (onSaved) onSaved(newSavedCase);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存到用例库失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      data-testid="save-to-library-modal-overlay"
    >
      <div
        className="dialog-content"
        style={{ maxWidth: '580px', width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="save-to-library-modal-content"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '16px',
            borderBottom: '1px solid var(--color-border-subtle)',
            paddingBottom: '12px',
          }}
        >
          <h3 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
            保存冒烟用例至项目用例库 (Save to Case Library)
          </h3>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="btn-close-save-modal"
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 14px',
              backgroundColor: 'var(--color-danger-bg)',
              border: '1px solid var(--color-danger-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-danger-text)',
              marginBottom: '16px',
              fontSize: '0.85rem',
            }}
            data-testid="save-modal-error"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <label
              htmlFor="case-slug"
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.9rem',
                marginBottom: '4px',
              }}
            >
              用例标识 Slug (唯一且不可变){' '}
              <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <input
              id="case-slug"
              type="text"
              className="input"
              style={{ width: '100%' }}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. checkout-flow-smoke"
              required
              data-testid="input-case-slug"
            />
            <p
              style={{
                fontSize: '0.75rem',
                color: 'var(--color-text-muted)',
                margin: '4px 0 0 0',
              }}
            >
              格式限制: 仅允许字母、数字、点号、中划线与下划线 (最大 120 字符)
            </p>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="case-name"
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.9rem',
                marginBottom: '4px',
              }}
            >
              用例显示名称 (Name){' '}
              <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <input
              id="case-name"
              type="text"
              className="input"
              style={{ width: '100%' }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 购物车核心流结算与优惠券抵扣验证"
              required
              data-testid="input-case-name"
            />
          </div>

          {/* Extraction summary */}
          <div
            style={{
              backgroundColor: 'var(--color-bg-base)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 16px',
              marginBottom: '20px',
              fontSize: '0.85rem',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '6px' }}>
              📦 本次将自动固化并生成的测试契约资产:
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: '20px',
                color: 'var(--color-text-muted)',
              }}
            >
              <li>
                <strong>判定准则 (Criteria): </strong>
                {cRecord.definition?.criteria?.length || 1} 项断言
              </li>
              <li>
                <strong>执行步骤 (Replay Steps): </strong>
                {rawSteps.length || 2} 项动作
              </li>
              <li>
                <strong>初始审查状态: </strong>
                生成版本 <code>v1</code> (草稿状态 <code>draft</code>
                )，需人工审查批准后方可纳入回归基线。
              </li>
            </ul>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              borderTop: '1px solid var(--color-border-subtle)',
              paddingTop: '16px',
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !slug.trim() || !name.trim()}
              data-testid="btn-confirm-save-to-library"
            >
              {loading ? '正在保存入库...' : '确认保存到用例库 (生成 Draft)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
