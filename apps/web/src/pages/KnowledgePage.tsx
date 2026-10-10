import React, { useEffect, useState } from 'react';
import type { Knowledge } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';

const kindMeta: Record<Knowledge['kind'], { label: string; badge: string }> = {
  rule: { label: '业务规则', badge: 'badge-primary' },
  restriction: { label: '禁止操作', badge: 'badge-danger' },
  terminology: { label: '业务术语', badge: 'badge-info' },
  flow: { label: '标准业务流', badge: 'badge-neutral' },
};

export const KnowledgePage: React.FC = () => {
  const { currentProject } = useAppContext();
  const [knowledgeList, setKnowledgeList] = useState<Knowledge[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<
    'rule' | 'restriction' | 'terminology' | 'flow'
  >('rule');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function load() {
      try {
        const res = await defaultApiClient.listKnowledge(projId);
        setKnowledgeList(res.items);
      } catch (err) {
        console.warn('Failed to load knowledge:', err);
      }
    }
    load();
  }, [currentProject]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !text.trim() || !currentProject) return;
    setLoading(true);
    try {
      const created = await defaultApiClient.createKnowledge(
        currentProject.id,
        {
          title,
          text,
          kind,
        },
      );
      setKnowledgeList([...knowledgeList, created]);
      setTitle('');
      setText('');
      setNotice(`已登记「${created.title}」（v${created.version}）`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page
      testId="knowledge-page"
      width="wide"
      title="项目知识"
      description="维护被测系统专属的业务预期、计算标准、术语和禁止操作边界，供运行时判定参考。"
    >
      <Alert tone="info" title="知识快照不会追溯修改">
        每次运行启动时会冻结当时的项目知识版本；之后新增或修改规则，不会改变历史运行的判定依据。
      </Alert>

      <div className="lqa-split">
        <Section icon="book" title="已登记的规则与约束">
          {knowledgeList.length === 0 ? (
            <EmptyState
              compact
              icon="book"
              title="暂无项目知识"
              description="在右侧登记第一条业务规则，运行时会作为判定依据的一部分。"
            />
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>规则</th>
                    <th>类型</th>
                    <th>内容与判定标准</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {knowledgeList.map((k) => (
                    <tr key={k.id} data-testid={`knowledge-row-${k.id}`}>
                      <td>
                        <div className="cell-title">{k.title}</div>
                        <div className="cell-sub mono">
                          {k.id} · v{k.version}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`badge ${kindMeta[k.kind]?.badge ?? 'badge-neutral'}`}
                        >
                          {kindMeta[k.kind]?.label ?? k.kind}
                        </span>
                      </td>
                      <td className="text-sm lqa-knowledge-text">{k.text}</td>
                      <td>
                        <span
                          className={`badge ${k.approved ? 'badge-success' : 'badge-warning'}`}
                        >
                          {k.approved ? '已批准' : '待审批'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section icon="plus" title="登记新规则">
          <form onSubmit={handleCreate}>
            <Field label="规则标题" required htmlFor="knowledge-title">
              <input
                id="knowledge-title"
                type="text"
                className="form-input"
                placeholder="例如：BR-102 订单满 99 元包邮"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </Field>
            <Field label="类型" htmlFor="knowledge-kind">
              <select
                id="knowledge-kind"
                className="form-select"
                value={kind}
                onChange={(e) =>
                  setKind(
                    e.target.value as
                      'rule' | 'restriction' | 'terminology' | 'flow',
                  )
                }
              >
                <option value="rule">业务规则</option>
                <option value="restriction">禁止操作</option>
                <option value="terminology">业务术语</option>
                <option value="flow">标准业务流</option>
              </select>
            </Field>
            <Field
              label="规则内容与验收标准"
              required
              hint="说明输入条件、预期计算方式和判定失败的阈值。"
              htmlFor="knowledge-text"
            >
              <textarea
                id="knowledge-text"
                className="form-textarea"
                rows={5}
                placeholder="例如：订单商品金额满 99 元时运费为 0，否则按地区运费表计算…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
              />
            </Field>
            {notice && (
              <Alert tone="success" role="status">
                {notice}
              </Alert>
            )}
            <div className="form-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? '正在登记...' : '登记规则'}
              </button>
            </div>
          </form>
        </Section>
      </div>
    </Page>
  );
};
