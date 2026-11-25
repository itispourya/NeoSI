import type { SupportedLanguage, TaskPriority } from '../db/schema.ts';
import { agentRuntime } from '../agent/runtime.ts';
import { classifyIntent, reasoningEngine, type ReasoningOutput } from './reasoning.ts';

export interface OrchestratorRequest {
  tenantId: string;
  actor: string;
  query: string;
  language?: SupportedLanguage;
  asyncTask?: boolean;
  autonomy?: 'low' | 'balanced' | 'high';
  priority?: TaskPriority;
  context?: Record<string, unknown>;
  scopes?: string[];
  piiRedaction?: boolean;
}

export class CognitiveOrchestrator {
  async dispatch(req: OrchestratorRequest): Promise<
    | { mode: 'sync'; reasoning: ReasoningOutput }
    | { mode: 'async_task'; taskId: string; intent: string; complexity: string }
  > {
    const { intent, complexity } = classifyIntent(req.query);
    if (req.asyncTask) {
      const task = await agentRuntime.createAndStartTask({
        tenantId: req.tenantId,
        actor: req.actor,
        goal: req.query,
        autonomy: req.autonomy || 'balanced',
        priority: req.priority || 'user_task',
        scopes: req.scopes || ['read', 'write'],
      });
      return {
        mode: 'async_task',
        taskId: task.id,
        intent,
        complexity,
      };
    }

    const reasoning = await reasoningEngine.run({
      tenantId: req.tenantId,
      actor: req.actor,
      query: req.query,
      language: req.language,
      context: req.context,
      autonomy: req.autonomy,
      scopes: req.scopes,
      piiRedaction: req.piiRedaction,
    });
    return { mode: 'sync', reasoning };
  }
}

export const cognitiveOrchestrator = new CognitiveOrchestrator();
