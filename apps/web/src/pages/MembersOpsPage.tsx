import React, { useEffect, useState } from 'react';
import type { Member, Health } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';

export const MembersOpsPage: React.FC = () => {
  const { currentProject } = useAppContext();
  const [members, setMembers] = useState<Member[]>([]);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function load() {
      try {
        const [mRes, hRes] = await Promise.all([
          defaultApiClient.listMembers(projId),
          defaultApiClient.healthReady(),
        ]);
        setMembers(mRes.items);
        setHealth(hRes);
      } catch (err) {
        console.warn('Failed to load members/health:', err);
      }
    }
    load();
  }, [currentProject]);

  return (
    <div className="app-container" data-testid="members-ops-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            项目成员与运维状态 (Members & Operations)
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            项目成员角色鉴权、执行槽位配额及平台核心服务健康度。
          </p>
        </div>

        {/* Section 1: System Health */}
        <div
          className="card"
          style={{ marginBottom: '24px' }}
          data-testid="system-health-card"
        >
          <div className="card-header">
            <h2 className="card-title">平台核心服务健康度 (System Health)</h2>
            <span
              className={`badge ${health?.status === 'ok' ? 'badge-success' : 'badge-warning'}`}
            >
              整体状态:{' '}
              {health?.status === 'ok' ? '就绪 (READY)' : '未就绪 (NOT_READY)'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '14px',
            }}
          >
            <div
              style={{
                padding: '12px',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
              >
                服务运行状态 (Status)
              </div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color:
                    health?.status === 'ok'
                      ? 'var(--color-success)'
                      : 'var(--color-warning)',
                  marginTop: '4px',
                }}
              >
                {health?.status === 'ok'
                  ? '🟢 就绪 (OK)'
                  : '🟡 检查中 / 未就绪'}
              </div>
            </div>

            <div
              style={{
                padding: '12px',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
              >
                契约协议版本 (Version)
              </div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: 'var(--color-text-main)',
                  marginTop: '4px',
                }}
              >
                🟢 v{health?.version || '1.0.0'}
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Members & RBAC */}
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">项目成员权限 (Members & RBAC)</h2>
            <span
              style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
            >
              项目级隔离：跨项目 ID 请求将被全局拦截
            </span>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户标识 (User ID)</th>
                  <th>项目内角色 (Project Role)</th>
                  <th>权限范围说明</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} data-testid={`member-row-${m.userId}`}>
                    <td>
                      <code>{m.userId}</code>
                    </td>
                    <td>
                      <StatusBadge status={m.role} size="sm" />
                    </td>
                    <td style={{ fontSize: '0.85rem' }}>
                      {m.role === 'owner' &&
                        '管理环境、成员、认证资料、项目知识及策略'}
                      {m.role === 'operator' &&
                        '启动冒烟、停止运行、补充说明、提交人工审查决议'}
                      {m.role === 'viewer' &&
                        '查看运行事实、测试报告与脱敏证据（只读）'}
                    </td>
                    <td>
                      <span className="badge badge-success">正常授权</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 3: Audit Log Preview */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">安全审计日志 (Audit Log)</h2>
            <span className="badge badge-neutral">保留期: 180 天</span>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontSize: '0.85rem',
            }}
          >
            <div
              style={{
                padding: '8px 12px',
                borderLeft: '3px solid var(--color-primary)',
                backgroundColor: 'var(--color-bg-subtle)',
              }}
            >
              <code>[2026-10-02 08:00:00]</code>{' '}
              <strong>usr_mock_admin_001</strong> 创建运行{' '}
              <code>run_mock_001_completed</code> (目标: http://localhost:8080/)
            </div>
            <div
              style={{
                padding: '8px 12px',
                borderLeft: '3px solid var(--color-warning)',
                backgroundColor: 'var(--color-bg-subtle)',
              }}
            >
              <code>[2026-10-02 08:02:10]</code>{' '}
              <strong>PolicyInterceptor</strong> 拦截危险变动:{' '}
              <code>/api/records/delete</code> (reasonCode: MUTATION_FORBIDDEN)
            </div>
            <div
              style={{
                padding: '8px 12px',
                borderLeft: '3px solid var(--color-success)',
                backgroundColor: 'var(--color-bg-subtle)',
              }}
            >
              <code>[2026-10-02 08:02:25]</code> <strong>Finalizer</strong>{' '}
              生成最终报告，写入持久存储并推送 <code>report.ready</code>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
