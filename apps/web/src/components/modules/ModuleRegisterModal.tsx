import React, { useState } from 'react';
import type {
  RegressionDocument,
  RegressionModuleRecord,
} from '@localqa/contracts';
import { validateContract } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { Modal } from '../ui/Modal.tsx';
import { Field } from '../ui/Field.tsx';
import { Alert } from '../ui/Alert.tsx';

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

  const close = () => {
    if (!loading) onClose();
  };

  return (
    <Modal
      title={
        isNewVersion
          ? `发布新版本：${existingModule.name}（v${existingModule.latestVersion + 1}）`
          : '注册模块'
      }
      onClose={close}
      size="lg"
      closeOnOverlay={false}
      overlayTestId="module-register-modal"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={close}
            disabled={loading}
          >
            取消
          </button>
          <button
            type="submit"
            form="module-register-form"
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
        </>
      }
    >
      <div className="stack stack-sm lqa-modal-alert">
        <Alert tone="info">
          模块创建后是草稿状态，需要项目负责人两阶段审查批准后，才能作为受控基线在回归中引用。
        </Alert>
        {error && (
          <Alert tone="danger" testId="module-register-error">
            {error}
          </Alert>
        )}
      </div>

      <form id="module-register-form" onSubmit={handleSubmit}>
        <Field label="模块名称" htmlFor="module-name-input">
          <input
            id="module-name-input"
            type="text"
            className="form-input is-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isNewVersion || loading}
            placeholder="auth_helper 或 checkout/coupon"
            data-testid="module-name-input"
          />
        </Field>

        <Field
          label="模块文档（RegressionDocument JSON）"
          htmlFor="module-document-json"
        >
          <textarea
            id="module-document-json"
            className="form-textarea is-mono lqa-code-area"
            rows={14}
            value={documentJson}
            onChange={(e) => setDocumentJson(e.target.value)}
            disabled={loading}
            data-testid="module-document-json-input"
          />
        </Field>
      </form>
    </Modal>
  );
};
