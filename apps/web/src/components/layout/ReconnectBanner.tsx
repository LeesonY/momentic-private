import React from 'react';
import type { SseConnectionStatus } from '../../api/sse.ts';

interface ReconnectBannerProps {
  status: SseConnectionStatus;
  attempt: number;
  onRetry: () => void;
}

export const ReconnectBanner: React.FC<ReconnectBannerProps> = ({
  status,
  attempt,
  onRetry,
}) => {
  if (status === 'connected') return null;

  const isReconnecting = status === 'reconnecting';
  const isConnecting = status === 'connecting';

  return (
    <div
      style={{
        backgroundColor: 'var(--color-warning-bg)',
        borderBottom: '1px solid var(--color-warning-border)',
        color: 'var(--color-warning-text)',
        padding: '10px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: '0.875rem',
        fontWeight: 500,
        boxShadow: 'var(--shadow-sm)',
      }}
      data-testid="reconnect-banner"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '1.2rem' }}>🔄</span>
        <div>
          {isReconnecting && (
            <span>
              <strong>正在重连实时事件流</strong>
              ：与服务端的连接已断开，正在执行自动重连（第 {attempt} 次尝试）...
              后台任务正常推进中，不会因断线丢失测试状态。
            </span>
          )}
          {isConnecting && <span>正在建立 SSE 实时状态流连接...</span>}
          {status === 'disconnected' && (
            <span>
              实时连接已关闭。您可以手动刷新或点击重试连接以获取最新运行事件。
            </span>
          )}
        </div>
      </div>
      <button
        className="btn btn-secondary btn-sm"
        onClick={onRetry}
        style={{
          borderColor: 'var(--color-warning-border)',
          backgroundColor: 'var(--color-bg-elevated)',
        }}
        data-testid="btn-retry-sse"
      >
        立即重试连接
      </button>
    </div>
  );
};
