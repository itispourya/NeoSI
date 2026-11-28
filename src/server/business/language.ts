import type { SupportedLanguage } from '../db/schema.ts';

const PERSIAN_SPECIFIC_CHARS = /[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/; // پ چ ژ گ ک ی
const ARABIC_SCRIPT_CHARS = /[\u0600-\u06FF]/;
const PERSIAN_STOPWORDS =
  /(?:^|[\s.,!؟،:()]+)(سلام|درود|تو|شما|من|ما|هستم|هستی|هستید|چطور|چطوری|خوبی|چیست|چند|چرا|چگونه|کدام|کمک|بگو|بده|کن|میتونی|میتوانی|می‌توانی|هوش|چت|است|هست|این|آن|برای|با|در|را|که|یک|می|شود|تحلیل|فروش|مالی|حسابداری)(?=$|[\s.,!؟،:()]+)/;
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

export function resolveConversationLanguage(
  text: string,
  explicit?: string,
  fallback: SupportedLanguage = 'en'
): SupportedLanguage {
  if (explicit === 'en' || explicit === 'fa' || explicit === 'ar' || explicit === 'nl') {
    return explicit;
  }
  const sample = (text || '').trim();
  if (!sample) return fallback;
  if (ARABIC_SCRIPT_CHARS.test(sample) || DUTCH_STOPWORDS.test(sample) || /[a-zA-Z]/.test(sample)) {
    return detectLanguage(sample);
  }
  return fallback;
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
