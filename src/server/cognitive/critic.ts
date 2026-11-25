import { safeArithmeticEval } from '../inference/runtimes.ts';
import { detectPromptInjection } from '../security/promptGuard.ts';

export interface CriticInput {
  goal: string;
  draftResponse: string;
  evidenceSnippets?: string[];
  citations?: Array<{ url: string; reliability?: number }>;
  toolOutputs?: Array<{ toolId: string; ok: boolean; output?: Record<string, unknown>; error?: string }>;
  generatedCode?: string;
}

export interface CriticVerdict {
  passed: boolean;
  overallScore: number;
  dimensions: {
    factualGrounding: number;
    completeness: number;
    safety: number;
    consistency: number;
    goalAlignment: number;
  };
  issues: string[];
  recommendations: string[];
}

const UNSAFE_CODE_PATTERNS = /\b(process\.exit|child_process|eval\(|new\s+Function|fs\.rmSync|rm\s+-rf)\b/;

/**
 * Independent Critic & Verification Engine (Stage 11 of Neo Cognitive Pipeline):
 * Checks factual grounding, numeric arithmetic consistency, safety/injection leaks, and goal completeness.
 */
export class CriticEngine {
  verify(input: CriticInput): CriticVerdict {
    const issues: string[] = [];
    const recommendations: string[] = [];
    const response = (input.draftResponse || '').trim();

    // 1. Completeness & Goal Alignment
    let completeness = response.length >= 24 ? 0.9 : response.length > 0 ? 0.55 : 0.0;
    if (response.length < 24) {
      issues.push('Response is empty or overly terse.');
      recommendations.push('Expand response with verified evidence or clear explanation.');
    }

    const goalTerms = input.goal
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const respLower = response.toLowerCase();
    const matchedGoalTerms = goalTerms.filter((t) => respLower.includes(t)).length;
    const goalAlignment =
      goalTerms.length === 0
        ? 0.85
        : Number(Math.min(1.0, 0.55 + (matchedGoalTerms / Math.max(1, Math.min(goalTerms.length, 5))) * 0.45).toFixed(2));

    // 2. Safety & Prompt Injection Leakage
    let safety = 1.0;
    const injectionScan = detectPromptInjection(response);
    if (injectionScan.flagged) {
      safety = 0.45;
      issues.push(`Response contains potential untrusted instruction leakage (${injectionScan.matches.join(', ')})`);
      recommendations.push('Strip instruction-override directives before returning output.');
    }
    if (input.generatedCode && UNSAFE_CODE_PATTERNS.test(input.generatedCode)) {
      safety = 0.25;
      issues.push('Generated code references restricted host execution primitives.');
      recommendations.push('Restrict generated handlers to pure deterministic functions.');
    }

    // 3. Factual Grounding & Citations
    const evidenceCount = (input.evidenceSnippets?.length || 0) + (input.citations?.length || 0);
    const successfulTools = (input.toolOutputs || []).filter((t) => t.ok).length;
    const failedTools = (input.toolOutputs || []).filter((t) => !t.ok).length;
    const normalizedGoal = input.goal.toLowerCase();
    const requiresExternalEvidence =
      /\b(latest|today|current|news|research|source|sources|citation|cite|compare|online|web|price|pricing|law|regulation|release|version|status)\b/i.test(normalizedGoal) ||
      /(جدیدترین|امروز|فعلی|اخبار|تحقیق|منبع|مقایسه|قیمت|قانون|مقررات|نسخه|وضعیت)/.test(normalizedGoal);
    const arithmeticRequested = /\d+\s*[+\-*/]\s*\d+/.test(input.goal);
    const arithmeticToolSucceeded = (input.toolOutputs || []).some((tool) => tool.toolId === 'math_evaluate' && tool.ok);
    let factualGrounding = evidenceCount > 0 || successfulTools > 0 ? 0.92 : requiresExternalEvidence ? 0.25 : 0.55;
    if (requiresExternalEvidence && evidenceCount === 0 && successfulTools === 0) {
      issues.push('The request requires current or external evidence, but no verified source or successful research tool output was available.');
      recommendations.push('Retry evidence acquisition or explicitly qualify the answer as unverified.');
    }
    if (failedTools > 0 && successfulTools === 0) {
      factualGrounding = Math.min(factualGrounding, 0.25);
      issues.push(`${failedTools} tool execution(s) failed while gathering evidence.`);
      recommendations.push('Do not treat failed tool execution as successful evidence.');
    }
    if (arithmeticRequested && !arithmeticToolSucceeded) {
      issues.push('The request contains an arithmetic expression but no successful deterministic math evaluation was recorded.');
      recommendations.push('Run the math_evaluate tool before treating the numerical result as verified.');
    }

    // 4. Consistency & Arithmetic Verification
    let consistency = 0.94;
    const inlineEquation = response.match(/([0-9+\-*/().\s]{3,40})\s*=\s*(-?\d+(?:\.\d+)?)/);
    if (inlineEquation) {
      const evaluated = safeArithmeticEval(inlineEquation[1]);
      const claimed = Number(inlineEquation[2]);
      if (evaluated !== null && Math.abs(evaluated - claimed) > 0.01) {
        consistency = 0.2;
        issues.push(`Arithmetic inconsistency: ${inlineEquation[1].trim()} equals ${evaluated}, not ${claimed}.`);
        recommendations.push('Recompute quantitative claims via math_evaluate tool.');
      }
    }

    const overallScore = Number(
      (
        (factualGrounding * 0.25 + completeness * 0.2 + safety * 0.25 + consistency * 0.15 + goalAlignment * 0.15) *
        100
      ).toFixed(1)
    );

    const missingRequiredEvidence = requiresExternalEvidence && evidenceCount === 0 && successfulTools === 0;
    const failedAllTools = failedTools > 0 && successfulTools === 0;
    const missingArithmeticCheck = arithmeticRequested && !arithmeticToolSucceeded;
    const passed =
      safety >= 0.7 &&
      consistency >= 0.7 &&
      completeness >= 0.5 &&
      overallScore >= 65 &&
      !missingRequiredEvidence &&
      !failedAllTools &&
      !missingArithmeticCheck;

    return {
      passed,
      overallScore,
      dimensions: {
        factualGrounding,
        completeness,
        safety,
        consistency,
        goalAlignment,
      },
      issues,
      recommendations,
    };
  }
}

export const criticEngine = new CriticEngine();
