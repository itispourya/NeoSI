import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import type { NeosApprovalStatus } from '../db/schema.ts';
import {
  NEOS_INTEGRATION_CONTRACT,
  confirmNeosApproval,
  executeOrQueueNeosAction,
  ingestNeosWorkspaceContext,
  rejectNeosApproval,
  syncTenantNeosCapabilities,
} from '../neos/integration.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';
import { asyncHandler } from '../security/headers.ts';

export const neosRouter = Router();

neosRouter.get('/neos/contract', requireApiGatewayAuth('read'), (_req, res) => {
  res.json(NEOS_INTEGRATION_CONTRACT);
});

neosRouter.get('/neos/capabilities', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const enabledOnly = req.query.enabled === 'true';
  const capabilities = await db.listNeosCapabilities(req.neoAuth!.tenant.id, enabledOnly);
  res.json({ capabilities, contractVersion: NEOS_INTEGRATION_CONTRACT.contractVersion });
}));

const syncCapabilitiesSchema = z.object({
  capabilities: z
    .array(
      z.object({
        module_name: z.string().min(1).max(80),
        capability_id: z.string().min(2).max(120).regex(/^[a-zA-Z0-9_.:-]+$/),
        title: z.string().min(2).max(160),
        description: z.string().min(2).max(1000),
        endpoint_url: z.string().url().nullable().optional(),
        required_scopes: z.array(z.enum(['read', 'write', 'forge', 'admin'])).optional(),
        risk_level: z.enum(['low', 'medium', 'high']).optional(),
        requires_confirmation: z.boolean().optional(),
        input_schema: z.record(z.string(), z.unknown()).optional(),
        output_schema: z.record(z.string(), z.unknown()).optional(),
        contract_version: z.string().max(40).optional(),
        enabled: z.boolean().optional(),
      })
    )
    .min(1)
    .max(100),
});

neosRouter.post('/neos/capabilities/sync', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = syncCapabilitiesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Neos capabilities payload', issues: parsed.error.issues });
  }
  const result = await syncTenantNeosCapabilities(req.neoAuth!.tenant.id, parsed.data.capabilities);
  const db = await getDb();
  await db.recordAuditLog({
    tenant_id: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    action: 'POST /api/v1/neos/capabilities/sync',
    resource: 'neos:capabilities',
    status_code: 200,
    metadata: { syncedCount: result.synced.length, rejectedCount: result.rejected.length },
  });
  return res.json(result);
}));

neosRouter.delete('/neos/capabilities/:id', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const deleted = await db.deleteNeosCapability(String(req.params.id), req.neoAuth!.tenant.id);
  if (!deleted) return res.status(404).json({ error: 'Neos capability not found in this workspace' });
  return res.json({ deleted: true });
}));

const contextSchema = z.object({
  moduleName: z.string().min(1).max(80),
  title: z.string().min(2).max(200),
  summary: z.string().max(8000).optional(),
  records: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
});

neosRouter.post('/neos/context', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = contextSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Neos context payload', issues: parsed.error.issues });
  }
  const memory = await ingestNeosWorkspaceContext({
    tenantId: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    moduleName: parsed.data.moduleName,
    title: parsed.data.title,
    summary: parsed.data.summary,
    records: parsed.data.records,
    piiRedaction: req.neoAuth!.tenant.pii_redaction,
  });
  return res.status(201).json({ memory: { ...memory, embedding: undefined } });
}));

const executeActionSchema = z.object({
  capabilityId: z.string().min(2).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
  actionSummary: z.string().max(300).optional(),
});

neosRouter.post('/neos/actions/execute', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = executeActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Neos action request', issues: parsed.error.issues });
  }
  const result = await executeOrQueueNeosAction({
    tenantId: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    scopes: req.neoAuth!.scopes,
    capabilityId: parsed.data.capabilityId,
    payload: parsed.data.payload,
    actionSummary: parsed.data.actionSummary,
  });
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error, issues: result.issues });
  }
  if (result.status === 'confirmation_required') {
    return res.status(202).json({
      status: 'confirmation_required',
      approval: result.approval,
      capability: result.capability,
    });
  }
  return res.json({
    status: 'executed',
    capability: result.capability,
    result: result.result,
  });
}));

neosRouter.get('/neos/approvals', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const rawStatus = req.query.status ? String(req.query.status) : undefined;
  const allowedStatuses: NeosApprovalStatus[] = ['pending', 'approved', 'rejected', 'executed', 'expired'];
  const status = rawStatus && allowedStatuses.includes(rawStatus as NeosApprovalStatus)
    ? (rawStatus as NeosApprovalStatus)
    : undefined;
  const approvals = await db.listNeosApprovals(req.neoAuth!.tenant.id, status, 50);
  res.json({ approvals });
}));

const decisionNoteSchema = z.object({
  decisionNote: z.string().max(400).optional(),
});

neosRouter.post('/neos/approvals/:id/confirm', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = decisionNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid confirmation body' });
  }
  const resConfirm = await confirmNeosApproval({
    approvalId: String(req.params.id),
    tenantId: req.neoAuth!.tenant.id,
    decisionBy: req.neoAuth!.actorLabel,
    scopes: req.neoAuth!.scopes,
    decisionNote: parsed.data.decisionNote,
  });
  if (!resConfirm.ok) {
    return res.status(resConfirm.statusCode).json({ error: resConfirm.error });
  }
  return res.json({ approval: resConfirm.approval });
}));

neosRouter.post('/neos/approvals/:id/reject', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = decisionNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid rejection body' });
  }
  const resReject = await rejectNeosApproval({
    approvalId: String(req.params.id),
    tenantId: req.neoAuth!.tenant.id,
    decisionBy: req.neoAuth!.actorLabel,
    decisionNote: parsed.data.decisionNote,
  });
  if (!resReject.ok) {
    return res.status(resReject.statusCode).json({ error: resReject.error });
  }
  return res.json({ approval: resReject.approval });
}));
