import React from 'react';
import type { SseConnectionStatus } from '../../api/sse.ts';
import { AppIcon } from '../ui/AppIcon.tsx';

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

  return (
    <div className="alert alert-warning" data-testid="reconnect-banner">
      <AppIcon name="refresh" size={16} />
      <div className="alert-body">
        {status === 'reconnecting' && (
          <>
            <div className="alert-title">
              正在重连实时事件流（第 {attempt} 次）
            </div>
            与服务端的连接已断开，正在自动重连。后台任务照常推进，不会因断线丢失测试状态。
          </>
        )}
        {status === 'connecting' && '正在建立实时状态连接…'}
        {status === 'disconnected' &&
          '实时连接已关闭。可以手动刷新，或点击右侧按钮重新连接以获取最新事件。'}
      </div>
      <div className="alert-actions">
        <button
          className="btn btn-secondary btn-sm"
          onClick={onRetry}
          data-testid="btn-retry-sse"
        >
          立即重连
        </button>
      </div>
    </div>
  );
};
