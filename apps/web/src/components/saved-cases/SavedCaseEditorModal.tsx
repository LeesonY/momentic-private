import React, { useState } from 'react';
import type {
  SavedCase,
  SavedCaseVersion,
  RegressionDocument,
  Criterion,
  ReplayStep,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';

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

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      data-testid="case-editor-modal-overlay"
    >
      <div
        className="dialog-content"
        style={{
          maxWidth: '780px',
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid="case-editor-modal-content"
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
          <div>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 600, margin: 0 }}>
              编辑用例并创建新草稿版本 (Create New Draft Version)
            </h3>
            <p
              style={{
                fontSize: '0.8rem',
                color: 'var(--color-text-muted)',
                margin: '4px 0 0 0',
              }}
            >
              基于 v{baseVersion.version} 编辑 · 提交后将生成全新版本{' '}
              <strong>v{caseRecord.version + 1} (Draft)</strong>
              ，历史版本永久不变。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            data-testid="btn-close-editor-modal"
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
            data-testid="editor-modal-error"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Case Name */}
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="editor-case-name"
              style={{
                display: 'block',
                fontWeight: 600,
                fontSize: '0.9rem',
                marginBottom: '4px',
              }}
            >
              用例名称 (Name)
            </label>
            <input
              id="editor-case-name"
              type="text"
              className="input"
              style={{ width: '100%' }}
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              required
              data-testid="input-editor-case-name"
            />
          </div>

          {/* Criteria Editor */}
          <div style={{ marginBottom: '20px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px',
              }}
            >
              <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                判定准则列表 (Criteria - {criteria.length} 项)
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleAddCriterion}
                data-testid="btn-add-criterion"
              >
                + 添加准则
              </button>
            </div>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              {criteria.map((c, idx) => (
                <div
                  key={c.id || idx}
                  style={{
                    backgroundColor: 'var(--color-bg-base)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: '10px',
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr 140px 1fr 32px',
                    gap: '8px',
                    alignItems: 'center',
                  }}
                  data-testid={`criterion-item-${idx}`}
                >
                  <select
                    className="input"
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
                    placeholder="准则业务描述"
                    value={c.description}
                    onChange={(e) =>
                      handleCriterionChange(idx, 'description', e.target.value)
                    }
                  />
                  <select
                    className="input"
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
                    className="input"
                    placeholder="定位值 (locator)"
                    value={c.locator?.value || ''}
                    onChange={(e) =>
                      handleCriterionChange(idx, 'locatorValue', e.target.value)
                    }
                  />
                  <button
                    type="button"
                    style={{
                      border: 'none',
                      background: 'none',
                      color: 'var(--color-danger)',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                    }}
                    onClick={() => handleRemoveCriterion(idx)}
                    title="删除该准则"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Replay Steps Editor */}
          <div style={{ marginBottom: '24px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px',
              }}
            >
              <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                回放执行步骤 (Replay Steps - {steps.length} 项)
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleAddStep('navigate')}
                  data-testid="btn-add-step-navigate"
                >
                  + 导航 (Navigate)
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleAddStep('click')}
                  data-testid="btn-add-step-click"
                >
                  + 点击 (Click)
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleAddStep('type_text')}
                  data-testid="btn-add-step-type"
                >
                  + 输入 (Type)
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleAddStep('assert')}
                  data-testid="btn-add-step-assert"
                >
                  + 断言 (Assert)
                </button>
              </div>
            </div>

            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              {steps.map((st, idx) => (
                <div
                  key={idx}
                  style={{
                    backgroundColor: 'var(--color-bg-base)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                  data-testid={`step-item-${idx}`}
                >
                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      backgroundColor: 'var(--color-primary)',
                      color: 'var(--color-primary-contrast)',
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      width: '80px',
                      textTransform: 'uppercase',
                    }}
                  >
                    {st.kind}
                  </span>

                  {st.kind === 'navigate' && (
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="URL 地址"
                      value={st.url}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSteps((prev) =>
                          prev.map((s, i) =>
                            i === idx && s.kind === 'navigate'
                              ? { ...s, url: val }
                              : s,
                          ),
                        );
                      }}
                    />
                  )}

                  {st.kind === 'click' && (
                    <input
                      type="text"
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="点击目标定位值"
                      value={st.locator.value}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSteps((prev) =>
                          prev.map((s, i) =>
                            i === idx && s.kind === 'click'
                              ? { ...s, locator: { ...s.locator, value: val } }
                              : s,
                          ),
                        );
                      }}
                    />
                  )}

                  {st.kind === 'type_text' && (
                    <div style={{ display: 'flex', flex: 1, gap: '8px' }}>
                      <input
                        type="text"
                        className="input"
                        style={{ flex: 1 }}
                        placeholder="输入框定位值"
                        value={st.locator.value}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSteps((prev) =>
                            prev.map((s, i) =>
                              i === idx && s.kind === 'type_text'
                                ? {
                                    ...s,
                                    locator: { ...s.locator, value: val },
                                  }
                                : s,
                            ),
                          );
                        }}
                      />
                      <input
                        type="text"
                        className="input"
                        style={{ flex: 1 }}
                        placeholder="填入文本"
                        value={st.text}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSteps((prev) =>
                            prev.map((s, i) =>
                              i === idx && s.kind === 'type_text'
                                ? { ...s, text: val }
                                : s,
                            ),
                          );
                        }}
                      />
                    </div>
                  )}

                  {st.kind === 'assert' && (
                    <select
                      className="input"
                      style={{ flex: 1 }}
                      value={st.criterionId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSteps((prev) =>
                          prev.map((s, i) =>
                            i === idx && s.kind === 'assert'
                              ? { ...s, criterionId: val }
                              : s,
                          ),
                        );
                      }}
                    >
                      {criteria.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.id}: {c.description}
                        </option>
                      ))}
                    </select>
                  )}

                  <button
                    type="button"
                    style={{
                      border: 'none',
                      background: 'none',
                      color: 'var(--color-danger)',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                    }}
                    onClick={() => handleRemoveStep(idx)}
                    title="删除该步骤"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
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
              disabled={loading}
              data-testid="btn-confirm-create-draft"
            >
              {loading
                ? '正在保存新草稿...'
                : '保存为新版本草稿 (v' + (caseRecord.version + 1) + ')'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
