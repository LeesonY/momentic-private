import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

type Theme = 'light' | 'dark';
interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'localqa:theme';
const ThemeContext = createContext<ThemeState | null>(null);

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function savedTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Storage may be disabled; system preference is still usable.
  }
  return systemTheme();
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(savedTheme);

  // Apply before painting on navigation and on each theme change.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Another tab can change the choice while this tab is open.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setTheme(savedTheme());
      }
    };
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      try {
        if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
      } catch {
        // Respect OS changes when storage access is unavailable.
      }
      setTheme(systemTheme());
    };
    window.addEventListener('storage', onStorage);
    media?.addEventListener('change', onSystemChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener('change', onSystemChange);
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Allow an in-memory toggle even in private browsing.
    }
    setTheme(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error('useTheme must be inside ThemeProvider');
  return state;
}
