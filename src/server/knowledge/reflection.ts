import { routeJsonLlmCall } from '../llm/router.ts';
import { jobQueue } from '../queue/jobQueue.ts';
import { storeMemory } from './memory.ts';

export interface ReflectionInput {
  tenantId: string;
  taskType: 'engineering' | 'business_analysis' | 'api_forge' | 'chat';
  goal: string;
  outcome: 'success' | 'failure' | 'partial';
  errorTrace?: string;
  durationMs: number;
  summary: string;
}

interface DistilledReflection {
  episodicTitle: string;
  episodicSummary: string;
  rootCause: string;
  proceduralRule: string;
  reusablePatternName: string;
}

export async function runReflectionTask(input: ReflectionInput): Promise<Record<string, unknown>> {
  let distilled: DistilledReflection;

  try {
    const { data } = await routeJsonLlmCall<DistilledReflection>({
      tenantId: input.tenantId,
      taskType: 'reflection_worker',
      thinkingLevel: 'LOW',
      systemInstruction:
        'You are Neo ReflectionWorker. Extract a concise episodic log and an actionable procedural rule so the system avoids repeating mistakes and compounds wins. Return strict JSON with keys: episodicTitle, episodicSummary, rootCause, proceduralRule, reusablePatternName.',
      prompt: JSON.stringify(input),
    });
    distilled = data;
  } catch {
    distilled = {
      episodicTitle: `${input.taskType} (${input.outcome}): ${input.goal.slice(0, 60)}`,
      episodicSummary: input.summary.slice(0, 320),
      rootCause: input.errorTrace ? input.errorTrace.slice(0, 240) : 'Completed within expected invariants',
      proceduralRule:
        input.outcome === 'success'
          ? `Validated workflow for ${input.taskType}: ${input.goal.slice(0, 120)}`
          : `Avoid failure in ${input.taskType}: verify inputs & sandbox assertions before finalizing (${input.errorTrace?.slice(0, 120) || 'runtime error'})`,
      reusablePatternName: `${input.taskType}-guardrail`,
    };
  }

  const episodic = await storeMemory({
    tenantId: input.tenantId,
    memoryType: 'episodic',
    topic: input.taskType,
    title: distilled.episodicTitle,
    content: distilled.episodicSummary,
    structuredFacts: {
      outcome: input.outcome,
      durationMs: input.durationMs,
      rootCause: distilled.rootCause,
    },
    reliabilityScore: input.outcome === 'success' ? 0.92 : 0.88,
  });

  const procedural = await storeMemory({
    tenantId: 'global',
    memoryType: 'procedural',
    topic: input.taskType,
    title: distilled.reusablePatternName,
    content: distilled.proceduralRule,
    structuredFacts: {
      derivedFromOutcome: input.outcome,
      rootCause: distilled.rootCause,
    },
    reliabilityScore: 0.94,
  });

  return {
    episodicId: episodic.id,
    proceduralId: procedural.id,
    pattern: distilled.reusablePatternName,
  };
}

export function registerReflectionWorker(): void {
  jobQueue.registerHandler('reflection', async (payload) => {
    return runReflectionTask(payload as unknown as ReflectionInput);
  });
}

export async function scheduleReflection(input: ReflectionInput): Promise<string> {
  return jobQueue.enqueue('reflection', 'reflection', input as unknown as Record<string, unknown>);
}
