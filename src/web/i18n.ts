// Which language the UI speaks. English is the default; `dbdialog --lang ja`
// changes the default for everyone, and the choice made in the toolbar is
// remembered by this browser.

import { en, type Message, type Params } from '../locales/en';
import { ja } from '../locales/ja';

export type Lang = 'en' | 'ja';
/** What `--lang` can say: a language, or "auto" for the browser's language. */
export type LangSetting = Lang | 'auto';

const dictionaries: Record<Lang, Record<string, Message>> = { en, ja };
const STORAGE_KEY = 'dbdialog.lang';

function stored(): Lang | null {
  if (typeof window === 'undefined') return null; // not in a browser (unit tests)
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'ja' ? v : null;
  } catch {
    return null; // Storage can be unavailable (private windows, blocked site data).
  }
}

function browserLang(): Lang {
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let current: Lang = stored() ?? 'en';

export function getLang(): Lang {
  return current;
}

/** Applies the server's default (from --lang) unless this browser chose a language. */
export function applyDefault(setting: LangSetting): Lang {
  if (stored() === null) current = setting === 'auto' ? browserLang() : setting;
  return current;
}

/** For this page only, not remembered (the agent view's ?lang=). */
export function setLangHere(lang: Lang): void {
  current = lang;
}

/** A choice made in the toolbar: used now and remembered by this browser. */
export function chooseLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not remembered; it still applies to this page.
  }
}

export function t(key: string, params: Params = {}): string {
  const m = dictionaries[current][key] ?? dictionaries.en[key];
  if (m === undefined) return key;
  return typeof m === 'function' ? m(params) : m;
}
