import { ReplyLanguageConfig } from './types';

export function isEnglishLanguage(language?: ReplyLanguageConfig): boolean {
  const probe = `${language?.code || ''} ${language?.label || ''}`.toLowerCase();
  return /\ben\b|english/.test(probe);
}

export function localize(language: ReplyLanguageConfig | undefined, zh: string, en: string): string {
  return isEnglishLanguage(language) ? en : zh;
}
