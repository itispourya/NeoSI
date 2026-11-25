import fs from 'node:fs';
import path from 'node:path';
import type { SupportedLanguage } from '../db/schema.ts';
import { retrieveRagContext } from '../knowledge/memory.ts';
import { executeHandlerInSandbox, type SandboxExecutionResult } from '../sandbox/runner.ts';

export interface PromotedModule {
  id: string;
  name: string;
  filePath: string;
  code: string;
  promotedAt: string;
}

const PROMOTED_DIR = path.resolve(process.cwd(), 'data', 'promoted-modules');

export function promoteVerifiedModule(id: string, targetFile: string, code: string): PromotedModule {
  fs.mkdirSync(PROMOTED_DIR, { recursive: true });
  const baseName = path.basename(targetFile).replace(/[^a-zA-Z0-9._-]/g, '_');
  const mod: PromotedModule = {
    id,
    name: baseName,
    filePath: targetFile,
    code,
    promotedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(PROMOTED_DIR, `${id}.json`), JSON.stringify(mod, null, 2), 'utf8');
  return mod;
}

export function removePromotedModule(id: string): boolean {
  const target = path.join(PROMOTED_DIR, `${id}.json`);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    return true;
  }
  return false;
}

export function listPromotedModules(): PromotedModule[] {
  if (!fs.existsSync(PROMOTED_DIR)) return [];
  const files = fs.readdirSync(PROMOTED_DIR).filter((f) => f.endsWith('.json'));
  const modules: PromotedModule[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(PROMOTED_DIR, file), 'utf8');
      modules.push(JSON.parse(raw) as PromotedModule);
    } catch {
      // skip malformed file
    }
  }
  return modules.sort((a, b) => b.promotedAt.localeCompare(a.promotedAt));
}

export function executePromotedModule(id: string, input: unknown): SandboxExecutionResult {
  const target = path.join(PROMOTED_DIR, `${id}.json`);
  if (!fs.existsSync(target)) {
    return { ok: false, logs: [], durationMs: 0, error: `Promoted module '${id}' not found` };
  }
  const mod = JSON.parse(fs.readFileSync(target, 'utf8')) as PromotedModule;
  return executeHandlerInSandbox(mod.code, input, 1500);
}

/**
 * Local extractive NLP distiller: extracts highest-information sentences and key terms
 * without calling any external cloud AI.
 */
export function distillTextLocally(topic: string, title: string, rawText: string) {
  const clean = rawText.replace(/\s+/g, ' ').trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 35 && s.length < 400);

  const topicTerms = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = sentences.map((sentence, idx) => {
    const lower = sentence.toLowerCase();
    let score = idx === 0 ? 1.5 : 0;
    for (const term of topicTerms) {
      if (lower.includes(term)) score += 2.0;
    }
    if (/\d+%|\b(must|should|always|never|invariant|ratio|latency|security)\b/i.test(sentence)) {
      score += 1.2;
    }
    return { sentence, score };
  });

  const topSentences = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((s) => s.sentence);

  const distilledSummary = topSentences.length > 0 ? topSentences.join(' ') : clean.slice(0, 900);

  // Extract capitalized or technical key tokens
  const entities = Array.from(new Set(clean.match(/\b[A-Z][a-zA-Z0-9_-]{2,24}\b/g) || [])).slice(0, 12);

  return {
    title,
    distilledSummary,
    structuredFacts: {
      engine: 'neo-local-extractive',
      topicTerms,
      keyEntities: entities,
      sentenceCount: sentences.length,
    },
  };
}

/**
 * Sovereign local cognitive response builder grounded strictly in Neo's own vector memory,
 * procedural lessons, and active skill registry.
 */
export async function generateSovereignLocalResponse(
  query: string,
  language: SupportedLanguage,
  tenantId = 'global'
): Promise<{ text: string; ragMatches: number }> {
  const rag = await retrieveRagContext(query, tenantId, 4);
  const ragMatches = rag.semantic.length + rag.procedural.length + rag.skills.length;

  const headers: Record<SupportedLanguage, string> = {
    en: 'Neo Sovereign Core — Grounded Memory Synthesis',
    fa: 'هسته مستقل Neo — پاسخ مبتنی بر حافظه و مهارت‌های داخلی',
    ar: 'نواة Neo المستقلة — استجابة مبنية على الذاكرة والمهارات الداخلية',
    nl: 'Neo Soevereine Kern — Synthese uit intern geheugen',
  };

  const emptyHints: Record<SupportedLanguage, string> = {
    en: 'No close matches found in local memory yet. Trigger Knowledge Ingestion on this topic so Neo learns and indexes verified sources.',
    fa: 'هنوز دانش مرتبطی در حافظه داخلی ثبت نشده است. از بخش یادگیری (Knowledge) موضوع را وارد کنید تا Neo منابع واقعی را استخراج و ذخیره کند.',
    ar: 'لم يتم العثور على معرفة مطابقة في الذاكرة المحلية بعد. قم بتشغيل التعلم لهذا الموضوع ليقوم Neo بفهرسته.',
    nl: 'Nog geen overeenkomsten in het lokale geheugen. Start kennisopname voor dit onderwerp.',
  };

  const parts: string[] = [headers[language]];

  if (rag.skills.length > 0) {
    parts.push(
      'Active Playbooks:\n' +
        rag.skills.map((s) => `• ${s.title} (v${s.version}): ${s.content.slice(0, 260).replace(/\n+/g, ' ')}`).join('\n')
    );
  }
  if (rag.procedural.length > 0) {
    parts.push(
      'Procedural Lessons:\n' +
        rag.procedural.map((m) => `• [${m.topic}] ${m.title}: ${m.content}`).join('\n')
    );
  }
  if (rag.semantic.length > 0) {
    parts.push(
      'Verified Semantic Memory:\n' +
        rag.semantic
          .map(
            (m) =>
              `• ${m.title} (sim ${(m.similarity * 100).toFixed(0)}%, rel ${m.reliability_score}): ${m.content}${
                m.source_url ? ` — ${m.source_url}` : ''
              }`
          )
          .join('\n')
    );
  }

  if (ragMatches === 0) {
    parts.push(emptyHints[language]);
  }

  return { text: parts.join('\n\n'), ragMatches };
}
