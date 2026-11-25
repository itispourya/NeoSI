import type { TaskPriority } from '../db/schema.ts';

export interface PlannedStep {
  stepIndex: number;
  title: string;
  actionType: 'memory_search' | 'tool_call' | 'reason' | 'research' | 'business_audit' | 'verify';
  toolId?: string;
  toolInput?: Record<string, unknown>;
  dependsOn: number[];
}

export interface PlanBudgets {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
}

export interface TaskPlanResult {
  steps: PlannedStep[];
  budgets: PlanBudgets;
  valid: boolean;
  validationErrors: string[];
}

/**
 * Dependency-aware DAG Task Planner & Plan Validator (Stages 5 & 6 of Neo Cognitive Core)
 */
export class TaskPlanner {
  buildPlan(goal: string, autonomy: 'low' | 'balanced' | 'high' = 'balanced'): TaskPlanResult {
    const clean = goal.trim();
    const steps: PlannedStep[] = [];
    const mathMatch = clean.match(/(\(?[0-9][0-9\s+\-*/().]*[+\-*/][0-9\s+\-*/().]*[0-9)])/);

    // Step 0: Always retrieve hybrid memory & relevant skills first
    steps.push({
      stepIndex: 0,
      title: 'Retrieve Hybrid Memory & Active Skills',
      actionType: 'memory_search',
      toolId: 'memory_search',
      toolInput: { query: clean.slice(0, 200), limit: 5 },
      dependsOn: [],
    });

    if (mathMatch) {
      const expr = mathMatch[1].trim();
      steps.push({
        stepIndex: steps.length,
        title: 'Deterministic Arithmetic Evaluation',
        actionType: 'tool_call',
        toolId: 'math_evaluate',
        toolInput: { expression: expr },
        dependsOn: [0],
      });
    }

    if (/\b(repo|file|code|src\/|server|typescript|function|sandbox|bug|module)\b/i.test(clean)) {
      steps.push({
        stepIndex: steps.length,
        title: 'Inspect Indexed Workspace Modules',
        actionType: 'tool_call',
        toolId: 'workspace_list_files',
        toolInput: { prefix: 'src/server' },
        dependsOn: [0],
      });
    }

    if (/\b(research|web|source|paper|latest|news|compare|verify online|arxiv|github)\b/i.test(clean)) {
      steps.push({
        stepIndex: steps.length,
        title: 'Execute 16-Stage Web Research & Citation Verification',
        actionType: 'research',
        toolId: 'web_research',
        toolInput: { query: clean.slice(0, 240) },
        dependsOn: [0],
      });
    }

    if (/\b(ledger|accounting|crm|inventory|kpi|cash|runway|ltv|cac|stockout|neos)\b/i.test(clean)) {
      steps.push({
        stepIndex: steps.length,
        title: 'Lookup Operational Business Playbooks & Graph Context',
        actionType: 'tool_call',
        toolId: 'skill_lookup',
        toolInput: { query: clean.slice(0, 180) },
        dependsOn: [0],
      });
    }

    const gatherDeps = steps.map((s) => s.stepIndex);
    const synthIdx = steps.length;
    steps.push({
      stepIndex: synthIdx,
      title: 'Synthesize Evidence-Grounded Output',
      actionType: 'reason',
      dependsOn: gatherDeps,
    });

    steps.push({
      stepIndex: synthIdx + 1,
      title: 'Independent Critic & Consistency Verification',
      actionType: 'verify',
      dependsOn: [synthIdx],
    });

    const budgets: PlanBudgets =
      autonomy === 'high'
        ? { maxSteps: 14, maxToolCalls: 10, maxDurationMs: 60_000 }
        : autonomy === 'low'
        ? { maxSteps: 6, maxToolCalls: 4, maxDurationMs: 20_000 }
        : { maxSteps: 10, maxToolCalls: 7, maxDurationMs: 35_000 };

    const validation = this.validatePlan(steps, budgets);
    return {
      steps,
      budgets,
      valid: validation.valid,
      validationErrors: validation.errors,
    };
  }

  validatePlan(steps: PlannedStep[], budgets: PlanBudgets): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (steps.length === 0) errors.push('Plan contains zero steps.');
    if (steps.length > budgets.maxSteps) {
      errors.push(`Plan step count (${steps.length}) exceeds maxSteps budget (${budgets.maxSteps}).`);
    }

    const indices = new Set(steps.map((s) => s.stepIndex));
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!indices.has(dep)) errors.push(`Step ${step.stepIndex} depends on missing step ${dep}.`);
        if (dep >= step.stepIndex) errors.push(`Potential cycle/forward dependency: step ${step.stepIndex} -> ${dep}.`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  detectLoop(signatureCounts: Record<string, number>, signature: string, maxRepeats = 3): { looped: boolean; count: number } {
    const next = (signatureCounts[signature] || 0) + 1;
    signatureCounts[signature] = next;
    return { looped: next >= maxRepeats, count: next };
  }

  selectPriority(requested?: TaskPriority): TaskPriority {
    return requested || 'user_task';
  }
}

export const taskPlanner = new TaskPlanner();
