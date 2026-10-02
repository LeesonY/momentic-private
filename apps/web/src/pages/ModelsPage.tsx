import React, { useEffect, useState } from 'react';
import type { ModelProfile } from '@localqa/contracts';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';

export const ModelsPage: React.FC = () => {
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [probeResults, setProbeResults] = useState<
    Record<string, { healthy: boolean; latencyMs: number }>
  >({});
  const [probingId, setProbingId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await defaultApiClient.listModels();
        setModels(res.items);
      } catch (err) {
        console.warn('Failed to load models:', err);
      }
    }
    load();
  }, []);

  const handleProbe = async (modelId: string) => {
    setProbingId(modelId);
    try {
      const res = await defaultApiClient.probeModel(modelId);
      setProbeResults((prev) => ({ ...prev, [modelId]: res }));
    } catch {
      setProbeResults((prev) => ({
        ...prev,
        [modelId]: { healthy: false, latencyMs: 0 },
      }));
    } finally {
      setProbingId(null);
    }
  };

  return (
    <div className="app-container" data-testid="models-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            AI 模型管理与能力探测 (Model Management)
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            维护 Coordinator / Explorer / Executor / Reproducer
            所需的推理模型配置，严格标明外部数据去向。
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {models.map((m) => {
            const probe = probeResults[m.id];
            const isInternal = m.dataBoundary === 'internal';
            return (
              <div
                key={m.id}
                className="card"
                data-testid={`model-card-${m.id}`}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '10px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                  >
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
                      {m.name}
                    </h3>
                    <span
                      className={`badge ${isInternal ? 'badge-success' : 'badge-warning'}`}
                    >
                      {isInternal ? '内网本地部署' : '外部云端商业服务'}
                    </span>
                    <span className="badge badge-neutral">
                      适配器: {m.adapter}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                  >
                    {probe && (
                      <span
                        className="badge"
                        style={{
                          backgroundColor: probe.healthy
                            ? 'var(--color-success-bg)'
                            : 'var(--color-danger-bg)',
                          color: probe.healthy
                            ? 'var(--color-success-text)'
                            : 'var(--color-danger-text)',
                        }}
                      >
                        {probe.healthy
                          ? `可用 (延迟: ${probe.latencyMs}ms)`
                          : '探测失败'}
                      </span>
                    )}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleProbe(m.id)}
                      disabled={probingId === m.id}
                      data-testid={`btn-probe-${m.id}`}
                    >
                      {probingId === m.id
                        ? '正在探测...'
                        : '连通性探测 (Probe)'}
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--color-text-main)',
                    marginBottom: '8px',
                  }}
                >
                  Model ID: <code>{m.configuredModelId}</code> · Endpoint:{' '}
                  <code>{m.endpoint}</code> · 状态: <code>{m.status}</code>
                </div>

                {/* Capabilities Badges */}
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    margin: '10px 0',
                    fontSize: '0.75rem',
                  }}
                >
                  <span
                    className={`badge ${m.capabilities.structuredOutput ? 'badge-info' : 'badge-neutral'}`}
                  >
                    结构化输出 (JSON):{' '}
                    {m.capabilities.structuredOutput ? '支持' : '不支持'}
                  </span>
                  <span
                    className={`badge ${m.capabilities.nativeTools ? 'badge-info' : 'badge-neutral'}`}
                  >
                    原生工具调用 (Tool Call):{' '}
                    {m.capabilities.nativeTools ? '支持' : '不支持'}
                  </span>
                  <span
                    className={`badge ${m.capabilities.imageInput ? 'badge-info' : 'badge-neutral'}`}
                  >
                    视觉截图解析 (Vision):{' '}
                    {m.capabilities.imageInput ? '支持' : '不支持'}
                  </span>
                </div>

                {/* Data Notice */}
                {!isInternal ? (
                  <div
                    style={{
                      padding: '8px 12px',
                      backgroundColor: 'var(--color-warning-bg)',
                      border: '1px solid var(--color-warning-border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.8rem',
                      color: 'var(--color-warning-text)',
                    }}
                  >
                    【外部模型数据提示】Prompt、节点标签及页面截图将加密出网发送至外部商业模型服务，请勿在无脱敏策略下传递涉密数据。
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '8px 12px',
                      backgroundColor: 'var(--color-bg-subtle)',
                      border: '1px solid var(--color-border-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.8rem',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    【内网模型提示】全链路均在本地算力网络运行，零外网数据泄漏风险。
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
};
