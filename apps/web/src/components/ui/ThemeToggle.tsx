import React from 'react';
import { useTheme } from '../../state/ThemeContext.tsx';
import { AppIcon } from './AppIcon.tsx';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="lqa-icon-button"
      title={dark ? '切换到浅色模式' : '切换到深色模式'}
      aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
      aria-pressed={dark}
      onClick={toggleTheme}
      data-testid="theme-toggle"
    >
      <AppIcon name={dark ? 'sun' : 'moon'} size={19} />
    </button>
  );
}
