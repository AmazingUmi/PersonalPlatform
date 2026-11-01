import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "en" | "zh";
export type Translate = (english: string, chinese: string) => string;
export const LANGUAGE_STORAGE_KEY = "personal-platform.language";
const valid = (value: unknown): value is Language => value === "en" || value === "zh";
function initialPreference(): Language {
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (valid(saved)) return saved;
  } catch { /* Storage may be disabled; in-memory switching still works. */ }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
interface I18nValue {
  language: Language;
  locale: "en-US" | "zh-CN";
  setLanguage: (language: Language) => void;
  t: Translate;
}
const I18nContext = createContext<I18nValue>({ language: "en", locale: "en-US", setLanguage: () => {}, t: english => english });

export function I18nProvider({ children, initialLanguage }: { children: ReactNode; initialLanguage?: Language }) {
  const [language, setLanguage] = useState<Language>(() => initialLanguage ?? initialPreference());
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Optional persistence. */ }
  }, [language]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY && valid(event.newValue)) setLanguage(event.newValue);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const value = useMemo<I18nValue>(() => ({ language, locale: language === "zh" ? "zh-CN" : "en-US", setLanguage,
    t: (english, chinese) => language === "zh" ? chinese : english }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export const useI18n = () => useContext(I18nContext);
