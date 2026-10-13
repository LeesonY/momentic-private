import React, { useEffect, useId, useRef, useState } from 'react';
import { AppIcon } from './AppIcon.tsx';
import './AgentConcurrencyPicker.css';

const MAX_AGENTS = 25;

export function AgentConcurrencyPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const labelId = useId();

  useEffect(() => setDraft(String(value)), [value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const change = (raw: string) => {
    setDraft(raw);
    if (raw.trim() === '') return;
    const number = Number(raw);
    if (!Number.isFinite(number)) return;
    const next = Math.max(1, Math.min(MAX_AGENTS, Math.trunc(number)));
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className="lqa-agent-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="lqa-composer-chip lqa-agent-picker-trigger"
        aria-label={`并行代理数量：${value}`}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        aria-controls={panelId}
        disabled={disabled}
        data-testid="agent-concurrency-picker"
        onClick={() => setOpen((previous) => !previous)}
      >
        <AppIcon name="users" size={15} />
        <span>代理</span>
        <span className="lqa-agent-picker-count">{value}</span>
      </button>
      {open && !disabled && (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={labelId}
          className="lqa-agent-picker-panel"
        >
          <div className="lqa-agent-picker-heading">
            <label id={labelId} htmlFor={`${panelId}-number`}>
              并行代理
            </label>
            <input
              id={`${panelId}-number`}
              type="number"
              min={1}
              max={MAX_AGENTS}
              step={1}
              value={draft}
              autoFocus
              data-testid="agent-concurrency-number"
              onChange={(event) => change(event.target.value)}
              onBlur={() => setDraft(String(value))}
            />
          </div>
          <input
            type="range"
            min={1}
            max={MAX_AGENTS}
            step={1}
            value={value}
            aria-label="并行代理数量"
            data-testid="agent-concurrency-range"
            onChange={(event) => change(event.target.value)}
          />
          <div className="lqa-agent-picker-limits" aria-hidden="true">
            <span>1</span>
            <span>{MAX_AGENTS}</span>
          </div>
        </div>
      )}
    </div>
  );
}
