import { Router } from 'express';
import { getDb } from '../db/adapter.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';
import { asyncHandler } from '../security/headers.ts';
import { toolRegistry } from '../tools/registry.ts';

export const toolsRouter = Router();

toolsRouter.get('/tools', requireApiGatewayAuth('read'), asyncHandler(async (_req, res) => {
  const db = await getDb();
  const dbRows = await db.listTools();
  res.json({ tools: toolRegistry.toPublicRecords(dbRows) });
}));

toolsRouter.get('/tools/executions', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const executions = await db.listToolExecutions(req.neoAuth!.tenant.id, 60);
  res.json({ executions });
}));

toolsRouter.post('/tools/:id/execute', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const toolId = String(req.params.id);
  const result = await toolRegistry.executeTool(toolId, req.body?.input ?? req.body ?? {}, {
    tenantId: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    taskId: typeof req.body?.taskId === 'string' ? req.body.taskId : null,
    scopes: req.neoAuth!.scopes,
  });

  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error, durationMs: result.durationMs });
  }
  return res.json(result);
}));

/**
 * MCP (Model Context Protocol) JSON-RPC endpoint
 */
toolsRouter.post('/mcp', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const { id = null, method, params } = (req.body || {}) as {
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };

  if (method === 'tools/list') {
    const result = await toolRegistry.mcpToolsList();
    return res.json({ jsonrpc: '2.0', id, result });
  }

  if (method === 'tools/call') {
    const toolName = String(params?.name || '');
    const args = params?.arguments ?? {};
    const result = await toolRegistry.mcpCallTool(toolName, args, {
      tenantId: req.neoAuth!.tenant.id,
      actor: req.neoAuth!.actorLabel,
      scopes: req.neoAuth!.scopes,
    });
    return res.json({ jsonrpc: '2.0', id, result });
  }

  return res.status(400).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported MCP method '${method || ''}'` },
  });
}));
