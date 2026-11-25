import type { SupportedLanguage } from '../db/schema.ts';

const PERSIAN_SPECIFIC_CHARS = /[پچژگک]/;
const ARABIC_SCRIPT_CHARS = /[\u0600-\u06FF]/;
const PERSIAN_STOPWORDS = /\b(است|هست|این|برای|با|در|را|که|یک|می|شود|تحلیل|فروش|مالی|حسابداری)\b/;
const DUTCH_STOPWORDS = /\b(het|een|van|voor|met|zijn|omzet|kosten|facturen|voorraad|klanten|marge)\b/i;

export function detectLanguage(text: string, explicit?: string): SupportedLanguage {
  if (explicit === 'en' || explicit === 'fa' || explicit === 'ar' || explicit === 'nl') {
    return explicit;
  }
  const sample = (text || '').trim();
  if (!sample) return 'en';

  if (ARABIC_SCRIPT_CHARS.test(sample)) {
    if (PERSIAN_SPECIFIC_CHARS.test(sample) || PERSIAN_STOPWORDS.test(sample)) {
      return 'fa';
    }
    return 'ar';
  }
  if (DUTCH_STOPWORDS.test(sample)) {
    return 'nl';
  }
  return 'en';
}

export function getLanguageDirective(lang: SupportedLanguage): string {
  switch (lang) {
    case 'fa':
      return 'Respond fluently and naturally in Persian (فارسی). Preserve exact numeric figures, currency symbols, SKU codes, and JSON field keys verbatim.';
    case 'ar':
      return 'Respond fluently and naturally in Modern Standard Arabic (العربية). Preserve exact numeric figures, currency symbols, SKU codes, and JSON field keys verbatim.';
    case 'nl':
      return 'Respond fluently and naturally in professional Dutch (Nederlands). Preserve exact numeric figures, currency symbols, SKU codes, and JSON field keys verbatim.';
    default:
      return 'Respond fluently in crisp executive English. Preserve exact numeric figures, currency symbols, SKU codes, and JSON field keys verbatim.';
  }
}
