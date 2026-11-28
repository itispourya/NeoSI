import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { NeosApprovalRecord, NeosCapabilityRecord } from '../db/schema.ts';
import { storeMemory } from '../knowledge/memory.ts';
import {
  redactUnknownObject,
  safeExternalFetch,
  signWebhookPayload,
  validateExternalUrlAsync,
} from '../security/crypto.ts';
import { sanitizeUntrustedContent } from '../security/promptGuard.ts';

export const NEOS_INTEGRATION_CONTRACT = {
  contractVersion: '1.0.0',
  providerName: 'NeoSI',
  supportedScopes: ['read', 'write', 'forge', 'admin'] as const,
  authSchemes: [
    'Authorization: Bearer neos_live_...',
    'X-API-Key: neos_live_...',
    'Authorization: Bearer neo_adm_...',
  ],
  openaiCompatibleEndpoints: [
    '/v1/models',
    '/v1/chat/completions',
    '/api/v1/models',
    '/api/v1/chat/completions',
  ],
  neosEndpoints: [
    '/api/v1/neos/contract',
    '/api/v1/neos/capabilities',
    '/api/v1/neos/capabilities/sync',
    '/api/v1/neos/capabilities/:id',
    '/api/v1/neos/context',
    '/api/v1/neos/actions/execute',
    '/api/v1/neos/approvals',
    '/api/v1/neos/approvals/:id/confirm',
    '/api/v1/neos/approvals/:id/reject',
  ],
  workflowHooks: [
    'context.sync',
    'action.propose',
    'action.confirm',
    'action.reject',
    'business.audit',
  ],
  securityGuarantees: {
    tenantIsolation: true,
    failClosedAuth: true,
    ssrfProtection: true,
    hmacWebhookSigning: true,
    highRiskHumanConfirmationRequired: true,
    untrustedDataPromptWrapping: true,
  },
} as const;

export function hasRequiredNeosScopes(granted: string[], required: string[]): boolean {
  if (granted.includes('admin')) return true;
  return required.every((scope) => granted.includes(scope));
}

export function validatePayloadAgainstSchema(
  payload: Record<string, unknown>,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      errors.push(`Missing required field: ${key}`);
    }
  }

  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const val = payload[key];
    if (val === undefined || val === null) continue;
    const expectedType = typeof propSchema.type === 'string' ? propSchema.type : undefined;
    if (expectedType === 'string' && typeof val !== 'string') {
      errors.push(`Field '${key}' must be a string.`);
    } else if (expectedType === 'number' && (typeof val !== 'number' || !Number.isFinite(val))) {
      errors.push(`Field '${key}' must be a finite number.`);
    } else if (expectedType === 'integer' && (typeof val !== 'number' || !Number.isInteger(val))) {
      errors.push(`Field '${key}' must be an integer.`);
    } else if (expectedType === 'boolean' && typeof val !== 'boolean') {
      errors.push(`Field '${key}' must be a boolean.`);
    } else if (expectedType === 'array' && !Array.isArray(val)) {
      errors.push(`Field '${key}' must be an array.`);
    } else if (expectedType === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
      errors.push(`Field '${key}' must be an object.`);
    }

    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
      errors.push(`Field '${key}' must be one of: ${propSchema.enum.join(', ')}.`);
    }
    if (typeof propSchema.minimum === 'number' && typeof val === 'number' && val < propSchema.minimum) {
      errors.push(`Field '${key}' must be >= ${propSchema.minimum}.`);
    }
    if (typeof propSchema.maximum === 'number' && typeof val === 'number' && val > propSchema.maximum) {
      errors.push(`Field '${key}' must be <= ${propSchema.maximum}.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isHighRiskNeosCapability(cap: Pick<NeosCapabilityRecord, 'capability_id' | 'risk_level' | 'requires_confirmation'>): boolean {
  if (cap.requires_confirmation || cap.risk_level === 'high') return true;
  return /(payment|transfer|refund|payroll|ledger\.commit|invoice\.post|delete|purge|wire)/i.test(cap.capability_id);
}

export interface CapabilitySyncItem {
  module_name: string;
  capability_id: string;
  title: string;
  description: string;
  endpoint_url?: string | null;
  required_scopes?: string[];
  risk_level?: 'low' | 'medium' | 'high';
  requires_confirmation?: boolean;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  contract_version?: string;
  enabled?: boolean;
}

export async function syncTenantNeosCapabilities(
  tenantId: string,
  items: CapabilitySyncItem[],
  opts?: { skipDnsValidation?: boolean }
): Promise<{ synced: NeosCapabilityRecord[]; rejected: Array<{ capability_id: string; reason: string }> }> {
  const db = await getDb();
  const synced: NeosCapabilityRecord[] = [];
  const rejected: Array<{ capability_id: string; reason: string }> = [];

  for (const item of items) {
    if (item.endpoint_url && !opts?.skipDnsValidation) {
      const check = await validateExternalUrlAsync(item.endpoint_url);
      if (!check.valid) {
        rejected.push({ capability_id: item.capability_id, reason: `Unsafe endpoint_url: ${check.reason}` });
        continue;
      }
    }
    const rec = await db.upsertNeosCapability({
      tenant_id: tenantId,
      module_name: item.module_name.trim(),
      capability_id: item.capability_id.trim(),
      title: item.title.trim(),
      description: item.description.trim(),
      endpoint_url: item.endpoint_url ?? null,
      required_scopes: item.required_scopes?.length ? item.required_scopes : ['write'],
      risk_level: item.risk_level ?? 'medium',
      requires_confirmation: Boolean(item.requires_confirmation ?? item.risk_level === 'high'),
      input_schema: item.input_schema ?? {},
      output_schema: item.output_schema ?? {},
      contract_version: item.contract_version ?? NEOS_INTEGRATION_CONTRACT.contractVersion,
      enabled: item.enabled ?? true,
    });
    synced.push(rec);
  }

  return { synced, rejected };
}

export async function ingestNeosWorkspaceContext(input: {
  tenantId: string;
  actor: string;
  moduleName: string;
  title: string;
  summary?: string;
  records?: Array<Record<string, unknown>>;
  piiRedaction?: boolean;
}) {
  const rawSummary = input.summary || '';
  const rawRecords = Array.isArray(input.records) ? input.records.slice(0, 30) : [];
  const cleanSummary = input.piiRedaction ? String(redactUnknownObject(rawSummary)) : rawSummary;
  const cleanRecords = input.piiRedaction ? redactUnknownObject(rawRecords) : rawRecords;
  const combinedText = [
    cleanSummary ? sanitizeUntrustedContent(cleanSummary, `neos_${input.moduleName}_summary`).wrappedData : '',
    cleanRecords.length > 0
      ? sanitizeUntrustedContent(JSON.stringify(cleanRecords, null, 2).slice(0, 5000), `neos_${input.moduleName}_records`).wrappedData
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const memory = await storeMemory({
    tenantId: input.tenantId,
    memoryType: 'organizational',
    topic: `neos:${input.moduleName}`,
    title: input.title,
    content: combinedText || `Neos workspace context snapshot for module ${input.moduleName}.`,
    structuredFacts: {
      moduleName: input.moduleName,
      recordCount: rawRecords.length,
      syncedBy: input.actor,
      syncedAt: new Date().toISOString(),
    },
    reliabilityScore: 0.9,
    importanceScore: 0.78,
    epistemicStatus: 'observation',
    retentionPolicy: 'long_term',
  });

  const db = await getDb();
  await db.recordAuditLog({
    tenant_id: input.tenantId,
    actor: input.actor,
    action: 'neos.context.sync',
    resource: `neos:${input.moduleName}`,
    status_code: 201,
    metadata: { memoryId: memory.id, recordCount: rawRecords.length },
  });

  return memory;
}

async function dispatchCapabilityCallback(
  tenantId: string,
  capability: NeosCapabilityRecord,
  payload: Record<string, unknown>,
  actor: string
): Promise<Record<string, unknown>> {
  const db = await getDb();
  const tenant = await db.getTenantById(tenantId);
  if (!capability.endpoint_url) {
    return {
      dispatched: false,
      mode: 'contract_validated_local_dispatch',
      capabilityId: capability.capability_id,
      moduleName: capability.module_name,
      payload,
      note: 'Capability has no external webhook endpoint_url; action validated and authorized for Neos client execution.',
    };
  }

  const body = JSON.stringify({
    event: 'neos.capability.execute',
    capabilityId: capability.capability_id,
    moduleName: capability.module_name,
    tenantId,
    actor,
    payload,
    timestamp: new Date().toISOString(),
  });
  const secret = tenant?.webhook_secret || env.webhookSecret || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) {
    headers['X-Neo-Signature'] = signWebhookPayload(body, secret).header;
  }

  const res = await safeExternalFetch(capability.endpoint_url, {
    method: 'POST',
    headers,
    body,
    timeoutMs: 8000,
    maxRedirects: 2,
    maxBytes: 256_000,
  });

  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(res.bodyText);
  } catch {
    parsedBody = res.bodyText.slice(0, 1000);
  }

  return {
    dispatched: true,
    mode: 'http_signed_webhook',
    statusCode: res.response.status,
    ok: res.response.ok,
    finalUrl: res.finalUrl,
    response: parsedBody,
  };
}

export type ExecuteNeosActionResult =
  | { ok: true; status: 'executed'; capability: NeosCapabilityRecord; result: Record<string, unknown> }
  | { ok: true; status: 'confirmation_required'; capability: NeosCapabilityRecord; approval: NeosApprovalRecord }
  | { ok: false; statusCode: number; error: string; issues?: string[] };

export async function executeOrQueueNeosAction(params: {
  tenantId: string;
  actor: string;
  scopes: string[];
  capabilityId: string;
  payload: Record<string, unknown>;
  actionSummary?: string;
}): Promise<ExecuteNeosActionResult> {
  const db = await getDb();
  const caps = await db.listNeosCapabilities(params.tenantId, true);
  const cap = caps.find((c) => c.capability_id === params.capabilityId);
  if (!cap) {
    return {
      ok: false,
      statusCode: 404,
      error: `Neos capability '${params.capabilityId}' is not registered or enabled for this tenant.`,
    };
  }

  if (!hasRequiredNeosScopes(params.scopes, cap.required_scopes)) {
    return {
      ok: false,
      statusCode: 403,
      error: `Permission denied for capability '${cap.capability_id}'. Required scopes: ${cap.required_scopes.join(', ')}.`,
    };
  }

  const validation = validatePayloadAgainstSchema(params.payload, cap.input_schema);
  if (!validation.valid) {
    return {
      ok: false,
      statusCode: 400,
      error: `Payload failed schema validation for '${cap.capability_id}'.`,
      issues: validation.errors,
    };
  }

  if (isHighRiskNeosCapability(cap)) {
    const approval = await db.createNeosApproval({
      tenant_id: params.tenantId,
      capability_id: cap.capability_id,
      actor: params.actor,
      action_summary: params.actionSummary || `${cap.title} [${cap.module_name}]`,
      payload: params.payload,
      required_scopes: cap.required_scopes,
      status: 'pending',
      decision_by: null,
      decision_note: null,
      execution_result: null,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    await db.recordAuditLog({
      tenant_id: params.tenantId,
      actor: params.actor,
      action: 'neos.action.confirmation_required',
      resource: `neos:${cap.capability_id}`,
      status_code: 202,
      metadata: { approvalId: approval.id, riskLevel: cap.risk_level },
    });

    return { ok: true, status: 'confirmation_required', capability: cap, approval };
  }

  const result = await dispatchCapabilityCallback(params.tenantId, cap, params.payload, params.actor);
  await db.recordAuditLog({
    tenant_id: params.tenantId,
    actor: params.actor,
    action: 'neos.action.executed',
    resource: `neos:${cap.capability_id}`,
    status_code: 200,
    metadata: { dispatched: result.dispatched, mode: result.mode },
  });

  return { ok: true, status: 'executed', capability: cap, result };
}

export async function confirmNeosApproval(params: {
  approvalId: string;
  tenantId: string;
  decisionBy: string;
  scopes: string[];
  decisionNote?: string;
}): Promise<{ ok: true; approval: NeosApprovalRecord } | { ok: false; statusCode: number; error: string }> {
  const db = await getDb();
  const approval = await db.getNeosApprovalById(params.approvalId, params.tenantId);
  if (!approval) {
    return { ok: false, statusCode: 404, error: 'Neos approval request not found in this workspace.' };
  }
  if (approval.status !== 'pending') {
    return { ok: false, statusCode: 409, error: `Approval request is already '${approval.status}'.` };
  }
  if (Date.parse(approval.expires_at) < Date.now()) {
    await db.updateNeosApproval(approval.id, params.tenantId, {
      status: 'expired',
      decision_by: 'system',
      decision_note: 'Approval window expired before confirmation.',
      decided_at: new Date().toISOString(),
    });
    return { ok: false, statusCode: 410, error: 'Approval request has expired.' };
  }
  if (!hasRequiredNeosScopes(params.scopes, approval.required_scopes)) {
    return {
      ok: false,
      statusCode: 403,
      error: `Missing required scopes to confirm action: ${approval.required_scopes.join(', ')}.`,
    };
  }

  const caps = await db.listNeosCapabilities(params.tenantId, false);
  const cap = caps.find((c) => c.capability_id === approval.capability_id);
  let executionResult: Record<string, unknown>;
  let nextStatus: 'approved' | 'executed' = 'approved';

  if (cap && cap.endpoint_url) {
    executionResult = await dispatchCapabilityCallback(params.tenantId, cap, approval.payload, params.decisionBy);
    nextStatus = 'executed';
  } else {
    executionResult = {
      dispatched: false,
      mode: 'human_confirmed_ready_for_neos_client',
      capabilityId: approval.capability_id,
      payload: approval.payload,
      confirmedAt: new Date().toISOString(),
    };
  }

  const updated = await db.updateNeosApproval(approval.id, params.tenantId, {
    status: nextStatus,
    decision_by: params.decisionBy,
    decision_note: params.decisionNote ?? null,
    execution_result: executionResult,
    decided_at: new Date().toISOString(),
  });

  await db.recordAuditLog({
    tenant_id: params.tenantId,
    actor: params.decisionBy,
    action: 'neos.approval.confirmed',
    resource: `neos:${approval.capability_id}`,
    status_code: 200,
    metadata: { approvalId: approval.id, status: nextStatus },
  });

  return { ok: true, approval: updated! };
}

export async function rejectNeosApproval(params: {
  approvalId: string;
  tenantId: string;
  decisionBy: string;
  decisionNote?: string;
}): Promise<{ ok: true; approval: NeosApprovalRecord } | { ok: false; statusCode: number; error: string }> {
  const db = await getDb();
  const approval = await db.getNeosApprovalById(params.approvalId, params.tenantId);
  if (!approval) {
    return { ok: false, statusCode: 404, error: 'Neos approval request not found in this workspace.' };
  }
  if (approval.status !== 'pending') {
    return { ok: false, statusCode: 409, error: `Approval request is already '${approval.status}'.` };
  }

  const updated = await db.updateNeosApproval(approval.id, params.tenantId, {
    status: 'rejected',
    decision_by: params.decisionBy,
    decision_note: params.decisionNote ?? 'Rejected by operator',
    decided_at: new Date().toISOString(),
  });

  await db.recordAuditLog({
    tenant_id: params.tenantId,
    actor: params.decisionBy,
    action: 'neos.approval.rejected',
    resource: `neos:${approval.capability_id}`,
    status_code: 200,
    metadata: { approvalId: approval.id },
  });

  return { ok: true, approval: updated! };
}
