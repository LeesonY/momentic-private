import React, { useState } from 'react';
import type {
  SavedCase,
  SavedCaseVersion,
  RegressionDocument,
  Criterion,
  ReplayStep,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';

interface SavedCaseEditorModalProps {
  caseRecord: SavedCase;
  baseVersion: SavedCaseVersion;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newVersion: SavedCaseVersion) => void;
}

export const SavedCaseEditorModal: React.FC<SavedCaseEditorModalProps> = ({
  caseRecord,
  baseVersion,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [docName, setDocName] = useState(
    baseVersion.document.name || caseRecord.name,
  );
  const [criteria, setCriteria] = useState<Criterion[]>([
    ...baseVersion.document.criteria,
  ]);
  const [steps, setSteps] = useState<ReplayStep[]>([
    ...baseVersion.document.steps,
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAddCriterion = () => {
    const newId = `crit-${Date.now().toString().slice(-4)}`;
    setCriteria((prev) => [
      ...prev,
      {
        id: newId,
        kind: 'element_visible',
        description: '新判定准则描述',
        sourceKind: 'saved_case',
        sourceRef: caseRecord.slug,
        locator: { by: 'css', value: '.target-element' },
      },
    ]);
  };

  const handleRemoveCriterion = (index: number) => {
    if (criteria.length <= 1) {
      setError('用例必须至少包含 1 项判定准则');
      return;
    }
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCriterionChange = (
    index: number,
    field: keyof Criterion | 'locatorBy' | 'locatorValue',
    value: string,
  ) => {
    setCriteria((prev) =>
      prev.map((c, i) => {
        if (i !== index) return c;
        if (field === 'locatorBy') {
          return {
            ...c,
            locator: {
              by: value as 'css' | 'test_id' | 'role' | 'label' | 'text',
              value: c.locator?.value || '',
            },
          };
        }
        if (field === 'locatorValue') {
          return {
            ...c,
            locator: {
              by: c.locator?.by || 'css',
              value,
            },
          };
        }
        return { ...c, [field]: value };
      }),
    );
  };

  const handleAddStep = (
    kind: 'navigate' | 'click' | 'type_text' | 'assert',
  ) => {
    if (kind === 'navigate') {
      setSteps((prev) => [
        ...prev,
        { kind: 'navigate', url: 'http://localhost:8080/' },
      ]);
    } else if (kind === 'click') {
      setSteps((prev) => [
        ...prev,
        { kind: 'click', locator: { by: 'css', value: 'button' } },
      ]);
    } else if (kind === 'type_text') {
      setSteps((prev) => [
        ...prev,
        {
          kind: 'type_text',
          locator: { by: 'css', value: 'input' },
          text: '示例输入文本',
        },
      ]);
    } else if (kind === 'assert') {
      setSteps((prev) => [
        ...prev,
        { kind: 'assert', criterionId: criteria[0]?.id || 'crit-01' },
      ]);
    }
  };

  const handleRemoveStep = (index: number) => {
    if (steps.length <= 1) {
      setError('用例必须至少包含 1 项执行步骤');
      return;
    }
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docName.trim()) {
      setError('请输入用例标题');
      return;
    }
    if (criteria.length === 0) {
      setError('用例必须包含至少 1 项判定准则');
      return;
    }
    if (steps.length === 0) {
      setError('用例必须包含至少 1 项执行步骤');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const document: RegressionDocument = {
        schemaVersion: 1,
        kind: 'localqa/test',
        id: caseRecord.slug,
        name: docName.trim(),
        variables: baseVersion.document.variables || {},
        criteria: criteria as [Criterion, ...Criterion[]],
        steps: steps as [ReplayStep, ...ReplayStep[]],
        fixtureRefs: baseVersion.document.fixtureRefs || [],
      };

      const newVersion = await defaultApiClient.createSavedCaseVersion(
        caseRecord.id,
        {
          expectedVersion: caseRecord.version,
          document,
        },
      );

      onSuccess(newVersion);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建新草稿版本失败');
    } finally {
      setLoading(false);
    }
  };

  const updateStep = (idx: number, change: (step: ReplayStep) => ReplayStep) =>
    setSteps((prev) => prev.map((s, i) => (i === idx ? change(s) : s)));

  return (
    <Modal
      title="编辑用例，创建新草稿"
      description={
        <>
          基于 v{baseVersion.version} 编辑；提交后生成新版本{' '}
          <strong>v{caseRecord.version + 1}（草稿）</strong>，历史版本保持不变。
        </>
      }
      onClose={onClose}
      size="xl"
      overlayTestId="case-editor-modal-overlay"
      testId="case-editor-modal-content"
      closeTestId="btn-close-editor-modal"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            form="case-editor-form"
            className="btn btn-primary"
            disabled={loading}
            data-testid="btn-confirm-create-draft"
          >
            {loading
              ? '正在保存新草稿...'
              : `保存为草稿 v${caseRecord.version + 1}`}
          </button>
        </>
      }
    >
      {error && (
        <Alert
          tone="danger"
          testId="editor-modal-error"
          className="lqa-modal-alert"
        >
          {error}
        </Alert>
      )}

      <form
        id="case-editor-form"
        onSubmit={handleSubmit}
        className="stack stack-lg"
      >
        <Field label="用例名称" htmlFor="editor-case-name">
          <input
            id="editor-case-name"
            type="text"
            className="input"
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            required
            data-testid="input-editor-case-name"
          />
        </Field>

        <div>
          <div className="lqa-editor-head">
            <span className="field-label">
              判定准则
              <span className="field-optional">{criteria.length} 项</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleAddCriterion}
              data-testid="btn-add-criterion"
            >
              <AppIcon name="plus" size={13} />
              添加准则
            </button>
          </div>
          <div className="lqa-editor-list">
            {criteria.map((c, idx) => (
              <div
                key={c.id || idx}
                className="lqa-editor-row lqa-criterion-row"
                data-testid={`criterion-item-${idx}`}
              >
                <select
                  className="input"
                  aria-label="准则类型"
                  value={c.kind}
                  onChange={(e) =>
                    handleCriterionChange(idx, 'kind', e.target.value)
                  }
                >
                  <option value="element_visible">元素可见</option>
                  <option value="text_equals">文本匹配</option>
                  <option value="url_matches">URL 匹配</option>
                  <option value="http_status">HTTP 状态</option>
                </select>
                <input
                  type="text"
                  className="input"
                  aria-label="准则描述"
                  placeholder="准则的业务描述"
                  value={c.description}
                  onChange={(e) =>
                    handleCriterionChange(idx, 'description', e.target.value)
                  }
                />
                <select
                  className="input"
                  aria-label="定位方式"
                  value={c.locator?.by || 'css'}
                  onChange={(e) =>
                    handleCriterionChange(idx, 'locatorBy', e.target.value)
                  }
                >
                  <option value="css">CSS 选择器</option>
                  <option value="test_id">Test ID</option>
                  <option value="role">Role 语义</option>
                  <option value="text">文本内容</option>
                </select>
                <input
                  type="text"
                  className="input is-mono"
                  aria-label="定位值"
                  placeholder="定位值"
                  value={c.locator?.value || ''}
                  onChange={(e) =>
                    handleCriterionChange(idx, 'locatorValue', e.target.value)
                  }
                />
                <button
                  type="button"
                  className="lqa-icon-button lqa-remove-button"
                  onClick={() => handleRemoveCriterion(idx)}
                  title="删除该准则"
                  aria-label="删除该准则"
                >
                  <AppIcon name="trash" size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="lqa-editor-head">
            <span className="field-label">
              回放步骤<span className="field-optional">{steps.length} 项</span>
            </span>
            <div className="btn-group">
              {(
                [
                  ['navigate', '导航', 'btn-add-step-navigate'],
                  ['click', '点击', 'btn-add-step-click'],
                  ['type_text', '输入', 'btn-add-step-type'],
                  ['assert', '断言', 'btn-add-step-assert'],
                ] as const
              ).map(([kind, label, testId]) => (
                <button
                  key={kind}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleAddStep(kind)}
                  data-testid={testId}
                >
                  <AppIcon name="plus" size={13} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="lqa-editor-list">
            {steps.map((st, idx) => (
              <div
                key={idx}
                className="lqa-editor-row lqa-step-edit-row"
                data-testid={`step-item-${idx}`}
              >
                <span className="lqa-step-seq">{idx + 1}</span>
                <span className="lqa-timeline-role lqa-step-kind">
                  {st.kind}
                </span>

                <div className="lqa-step-fields">
                  {st.kind === 'navigate' && (
                    <input
                      type="text"
                      className="input"
                      aria-label="URL 地址"
                      placeholder="URL 地址"
                      value={st.url}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateStep(idx, (s) =>
                          s.kind === 'navigate' ? { ...s, url: val } : s,
                        );
                      }}
                    />
                  )}

                  {st.kind === 'click' && (
                    <input
                      type="text"
                      className="input is-mono"
                      aria-label="点击目标定位值"
                      placeholder="点击目标定位值"
                      value={st.locator.value}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateStep(idx, (s) =>
                          s.kind === 'click'
                            ? { ...s, locator: { ...s.locator, value: val } }
                            : s,
                        );
                      }}
                    />
                  )}

                  {st.kind === 'type_text' && (
                    <>
                      <input
                        type="text"
                        className="input is-mono"
                        aria-label="输入框定位值"
                        placeholder="输入框定位值"
                        value={st.locator.value}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateStep(idx, (s) =>
                            s.kind === 'type_text'
                              ? { ...s, locator: { ...s.locator, value: val } }
                              : s,
                          );
                        }}
                      />
                      <input
                        type="text"
                        className="input"
                        aria-label="填入文本"
                        placeholder="填入文本"
                        value={st.text}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateStep(idx, (s) =>
                            s.kind === 'type_text' ? { ...s, text: val } : s,
                          );
                        }}
                      />
                    </>
                  )}

                  {st.kind === 'assert' && (
                    <select
                      className="input"
                      aria-label="断言准则"
                      value={st.criterionId}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateStep(idx, (s) =>
                          s.kind === 'assert' ? { ...s, criterionId: val } : s,
                        );
                      }}
                    >
                      {criteria.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id}：{c.description}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <button
                  type="button"
                  className="lqa-icon-button lqa-remove-button"
                  onClick={() => handleRemoveStep(idx)}
                  title="删除该步骤"
                  aria-label="删除该步骤"
                >
                  <AppIcon name="trash" size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
};
