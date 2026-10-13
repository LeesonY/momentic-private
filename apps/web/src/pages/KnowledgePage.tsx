import React, { useEffect, useState } from 'react';
import type { Knowledge } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';

type Kind = Knowledge['kind'];

/** Each category asks for the fields that describe it, as in Mo. */
const kindMeta: Record<
  Kind,
  {
    label: string;
    badge: string;
    titleLabel: string;
    titlePlaceholder: string;
    textLabel: string;
    textHint: string;
    textPlaceholder: string;
  }
> = {
  rule: {
    label: '业务规则',
    badge: 'badge-primary',
    titleLabel: '规则名称',
    titlePlaceholder: '例如：BR-102 订单满 99 元包邮',
    textLabel: '规则内容与验收标准',
    textHint: '写清输入条件、预期结果和判定失败的阈值，代理会照原文使用。',
    textPlaceholder:
      '例如：订单商品金额满 99 元时运费为 0，否则按地区运费表计算…',
  },
  restriction: {
    label: '禁止操作',
    badge: 'badge-danger',
    titleLabel: '禁止的操作',
    titlePlaceholder: '例如：不要删除生产数据',
    textLabel: '说明',
    textHint: '写清在哪些页面、对哪些对象不允许做什么。',
    textPlaceholder: '例如：在非测试专用页面中，不点击具有删除语义的按钮…',
  },
  terminology: {
    label: '术语',
    badge: 'badge-info',
    titleLabel: '规范术语',
    titlePlaceholder: '例如：结算单',
    textLabel: '定义',
    textHint: '说明这个词在本系统里的含义，以及常见的别称。',
    textPlaceholder: '例如：结算单是订单确认后生成的付款凭证，也叫“账单”…',
  },
  flow: {
    label: '业务流程',
    badge: 'badge-neutral',
    titleLabel: '流程名称',
    titlePlaceholder: '例如：下单与支付',
    textLabel: '步骤与预期',
    textHint: '按顺序写出步骤和每一步应看到的结果。',
    textPlaceholder:
      '例如：1. 加入购物车 → 2. 填写地址 → 3. 提交订单，应看到订单号…',
  },
};

const AddKnowledgeDialog: React.FC<{
  projectId: string;
  onClose: () => void;
  onCreated: (item: Knowledge) => void;
}> = ({ projectId, onClose, onCreated }) => {
  const [kind, setKind] = useState<Kind>('rule');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const meta = kindMeta[kind];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !text.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      onCreated(
        await defaultApiClient.createKnowledge(projectId, {
          title: title.trim(),
          text: text.trim(),
          kind,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="添加知识"
      description="知识会影响代理的行为和判定。选择类别，填写对应的内容。"
      onClose={() => {
        if (!saving) onClose();
      }}
      closeOnOverlay={!saving}
      testId="knowledge-create-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            form="knowledge-create-form"
            className="btn btn-primary"
            disabled={saving || !title.trim() || !text.trim()}
            data-testid="btn-create-knowledge"
          >
            {saving ? '保存中…' : '添加'}
          </button>
        </>
      }
    >
      <form id="knowledge-create-form" onSubmit={(e) => void submit(e)}>
        <Field label="类别" htmlFor="knowledge-kind">
          <select
            id="knowledge-kind"
            className="form-select"
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
          >
            {(Object.keys(kindMeta) as Kind[]).map((key) => (
              <option key={key} value={key}>
                {kindMeta[key].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={meta.titleLabel} required htmlFor="knowledge-title">
          <input
            id="knowledge-title"
            className="form-input"
            placeholder={meta.titlePlaceholder}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </Field>
        <Field
          label={meta.textLabel}
          required
          hint={meta.textHint}
          htmlFor="knowledge-text"
        >
          <textarea
            id="knowledge-text"
            className="form-textarea"
            rows={6}
            placeholder={meta.textPlaceholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </Field>
        <p className="field-hint">
          每次会话开始时会冻结当时的知识版本，之后的修改不影响已有会话的判定。
        </p>
        {error && (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        )}
      </form>
    </Modal>
  );
};

export const KnowledgePage: React.FC = () => {
  const { currentProject } = useAppContext();
  const [items, setItems] = useState<Knowledge[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setItems(null);
    if (!currentProject) return;
    let cancelled = false;
    defaultApiClient
      .listKnowledge(currentProject.id)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject]);

  const addButton = (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => {
        setNotice('');
        setAdding(true);
      }}
      data-testid="btn-add-knowledge"
    >
      <AppIcon name="plus" size={16} />
      添加知识
    </button>
  );

  return (
    <Page
      testId="knowledge-page"
      width="wide"
      title="知识库"
      description="告诉代理团队使用的术语、必须遵守的规则和产品的业务流程。"
      actions={currentProject && items && items.length > 0 ? addButton : null}
    >
      {notice && (
        <Alert tone="success" role="status">
          {notice}
        </Alert>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类别</th>
              <th>版本</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((k) => (
              <tr key={k.id} data-testid={`knowledge-row-${k.id}`}>
                <td>
                  <div className="cell-title">{k.title}</div>
                  <div className="cell-sub mo-knowledge-text">{k.text}</div>
                </td>
                <td>
                  <span
                    className={`badge ${kindMeta[k.kind]?.badge ?? 'badge-neutral'}`}
                  >
                    {kindMeta[k.kind]?.label ?? k.kind}
                  </span>
                </td>
                <td className="mono text-sm">v{k.version}</td>
                <td>
                  <span
                    className={`badge ${k.approved ? 'badge-success' : 'badge-warning'}`}
                  >
                    {k.approved ? '已启用' : '待审批'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items === null ? (
          <p className="mo-table-empty">正在读取知识…</p>
        ) : (
          items.length === 0 && (
            <div className="mo-table-empty" data-testid="knowledge-empty-state">
              <span className="mo-empty-icon">
                <AppIcon name="book" size={18} />
              </span>
              <strong>还没有知识</strong>
              <p>
                知识告诉代理团队使用的术语、必须遵守的规则，以及描述产品如何运作的流程。
              </p>
              <p>添加第一条，说明你的产品是怎么运作的。</p>
              {currentProject && addButton}
            </div>
          )
        )}
      </div>
      {adding && currentProject && (
        <AddKnowledgeDialog
          projectId={currentProject.id}
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setItems((old) => [...(old ?? []), created]);
            setAdding(false);
            setNotice(`已添加「${created.title}」（v${created.version}）`);
          }}
        />
      )}
    </Page>
  );
};
