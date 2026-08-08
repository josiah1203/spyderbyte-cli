import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolvedTheme: 'dark',
  setTheme: () => {},
});

const THEME_STORAGE_KEY = 'design-system-theme';

function readStoredTheme(): Theme {
  const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'system' || stored === 'dark' ? stored : 'dark';
}

function getSystemTheme(): ResolvedTheme {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [systemPrefers, setSystemPrefers] = useState<ResolvedTheme>(getSystemTheme);

  useEffect(() => {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    setSystemPrefers(mq.matches ? 'dark' : 'light');
    const handler = (event: MediaQueryListEvent) =>
      setSystemPrefers(event.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemPrefers : theme;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-theme-choice', theme);
    document.documentElement.style.colorScheme = resolvedTheme;
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  }, [resolvedTheme, theme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
