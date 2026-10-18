import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  /** Whether the dark theme is showing: chosen, or followed from the system. */
  dark: boolean;
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  dark: false,
  setTheme: () => null,
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The system's own theme, followed as it changes (index.css does the same for the colours). */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const update = () => setDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return dark;
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "papeer-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => {
      try {
        const saved = localStorage.getItem(storageKey);
        return saved === "light" || saved === "dark" || saved === "system" ? saved : defaultTheme;
      } catch {
        return defaultTheme;
      }
    }
  );
  const systemDark = useSystemDark();

  useEffect(() => {
    const root = window.document.documentElement;

    delete root.dataset.theme;

    if (theme === "system") {
      // the CSS media query prefers-color-scheme handles system theme, 
      // but if we want to explicitly know, we can do it here. 
      // the spec says we set data-theme="system" and let css handle it
      root.dataset.theme = "system";
      return;
    }

    root.dataset.theme = theme;
  }, [theme]);

  const value = {
    theme,
    dark: theme === "dark" || (theme !== "light" && systemDark),
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
