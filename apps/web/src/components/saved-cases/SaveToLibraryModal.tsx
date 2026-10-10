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
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';

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
    <Modal
      title="保存到用例库"
      description="把这次冒烟执行固化为可复用的测试用例，生成 v1 草稿。"
      onClose={onClose}
      overlayTestId="save-to-library-modal-overlay"
      testId="save-to-library-modal-content"
      closeTestId="btn-close-save-modal"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="save-to-library-form"
            className="btn btn-primary"
            disabled={loading || !slug.trim() || !name.trim()}
            data-testid="btn-confirm-save-to-library"
          >
            {loading ? '正在保存...' : '保存为草稿'}
          </button>
        </>
      }
    >
      {error && (
        <Alert
          tone="danger"
          testId="save-modal-error"
          className="lqa-modal-alert"
        >
          {error}
        </Alert>
      )}

      <form id="save-to-library-form" onSubmit={handleSubmit}>
        <Field
          label="用例标识（Slug）"
          required
          htmlFor="case-slug"
          hint="唯一且创建后不可修改；只允许字母、数字、点、中划线和下划线，最多 120 个字符。"
        >
          <input
            id="case-slug"
            type="text"
            className="input is-mono"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="例如 checkout-flow-smoke"
            required
            data-testid="input-case-slug"
          />
        </Field>

        <Field label="用例名称" required htmlFor="case-name">
          <input
            id="case-name"
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 购物车结算与优惠券抵扣验证"
            required
            data-testid="input-case-name"
          />
        </Field>

        <div className="panel">
          <div className="section-label">将要生成的内容</div>
          <dl className="kv">
            <dt>判定准则</dt>
            <dd>{cRecord.definition?.criteria?.length || 1} 项断言</dd>
            <dt>回放步骤</dt>
            <dd>{rawSteps.length || 2} 个动作</dd>
            <dt>初始状态</dt>
            <dd>
              v1 草稿（<code>draft</code>），经人工审查批准后才会成为回归基线。
            </dd>
          </dl>
        </div>
      </form>
    </Modal>
  );
};
