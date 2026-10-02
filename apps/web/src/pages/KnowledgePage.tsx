import React, { useEffect, useState } from 'react';
import type { Knowledge } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';

export const KnowledgePage: React.FC = () => {
  const { currentProject } = useAppContext();
  const [knowledgeList, setKnowledgeList] = useState<Knowledge[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<
    'rule' | 'restriction' | 'terminology' | 'flow'
  >('rule');
  const [loading, setLoading] = useState(false);

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
      alert('业务规则已记录为新版本');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container" data-testid="knowledge-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            项目知识与业务规则 (Project Knowledge)
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            维护被测系统专属的业务预期、优惠扣减计算标准及禁止操作边界。
          </p>
        </div>

        {/* Snapshot Notice Banner */}
        <div
          style={{
            backgroundColor: 'var(--color-info-bg)',
            border: '1px solid var(--color-info-border)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 16px',
            marginBottom: '20px',
            fontSize: '0.85rem',
            color: 'var(--color-info-text)',
          }}
        >
          <strong>【快照不变性约定】</strong>
          每次运行启动时将冻结当期项目知识版本快照，后续对规则的新增或修改不会暗中篡改历史运行与判定的依据。
        </div>

        {/* Rules Table */}
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">已生效业务规则与约束清单</h2>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '160px' }}>规则编号</th>
                  <th style={{ width: '140px' }}>类型</th>
                  <th style={{ width: '220px' }}>规则标题</th>
                  <th>详细正文与判定公式</th>
                  <th style={{ width: '100px' }}>版本</th>
                  <th style={{ width: '120px' }}>审批状态</th>
                </tr>
              </thead>
              <tbody>
                {knowledgeList.map((k) => (
                  <tr key={k.id} data-testid={`knowledge-row-${k.id}`}>
                    <td>
                      <code>{k.id}</code>
                    </td>
                    <td>
                      <span
                        className={`badge ${k.kind === 'rule' ? 'badge-primary' : 'badge-danger'}`}
                      >
                        {k.kind === 'rule'
                          ? '业务判定规则'
                          : k.kind === 'restriction'
                            ? '禁止危险操作'
                            : k.kind}
                      </span>
                    </td>
                    <td>
                      <strong>{k.title}</strong>
                    </td>
                    <td style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
                      {k.text}
                    </td>
                    <td>v{k.version}</td>
                    <td>
                      <span className="badge badge-success">
                        {k.approved ? '已批准' : '待审批'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Add Rule Form */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">登记新业务规则 (Add Rule)</h2>
          </div>

          <form onSubmit={handleCreate}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr',
                gap: '16px',
              }}
            >
              <div className="form-group">
                <label className="form-label">规则标题 (Title)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="例如: BR-102: 订单运费满 99 包邮规则"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">规则类型</label>
                <select
                  className="form-select"
                  value={kind}
                  onChange={(e) =>
                    setKind(
                      e.target.value as
                        'rule' | 'restriction' | 'terminology' | 'flow',
                    )
                  }
                >
                  <option value="rule">业务规则 (Rule)</option>
                  <option value="restriction">禁止操作 (Restriction)</option>
                  <option value="terminology">业务术语 (Terminology)</option>
                  <option value="flow">标准业务流 (Flow)</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">详细规则逻辑与验收标准</label>
              <textarea
                className="form-textarea"
                rows={4}
                placeholder="详细说明输入条件、预期计算公式以及失败判定阈值..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginTop: '14px',
              }}
            >
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={loading}
              >
                {loading ? '正在登记...' : '登记业务规则'}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
};
