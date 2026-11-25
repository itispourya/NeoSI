import { useState } from 'react';
import { apiFetch, getAdminToken, setAdminToken } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface SecurityViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function SecurityView({ data, onRefresh }: SecurityViewProps) {
  const [passcodeInput, setPasscodeInput] = useState('');
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [authErr, setAuthErr] = useState<string | null>(null);

  const [keyName, setKeyName] = useState('Neos Core Connector');
  const [selectedTenantId, setSelectedTenantId] = useState(data.tenants[0]?.id || '');
  const [newRawKey, setNewRawKey] = useState<string | null>(null);

  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [tenantLang, setTenantLang] = useState<'en' | 'fa' | 'ar' | 'nl'>('en');

  const [webhookPreview, setWebhookPreview] = useState<string | null>(null);

  const handleClaimAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthErr(null);
    setAuthMsg(null);
    try {
      const res = await apiFetch<{ token: string }>('/api/admin/auth/claim', {
        method: 'POST',
        body: JSON.stringify({ passcode: passcodeInput }),
      });
      setAdminToken(res.token);
      setPasscodeInput('');
      setAuthMsg('Admin passcode claimed and session unlocked.');
      await onRefresh();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Claim failed');
    }
  };

  const handleLoginAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthErr(null);
    try {
      const res = await apiFetch<{ token: string }>('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ passcode: passcodeInput }),
      });
      setAdminToken(res.token);
      setPasscodeInput('');
      setAuthMsg('Admin session authenticated.');
      await onRefresh();
    } catch (err) {
      setAuthErr(err instanceof Error ? err.message : 'Invalid passcode');
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTenantId || !keyName.trim()) return;
    const res = await apiFetch<{ rawKey: string }>('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: selectedTenantId,
        name: keyName.trim(),
        scopes: ['read', 'write', 'forge', 'admin'],
      }),
    });
    setNewRawKey(res.rawKey);
    await onRefresh();
  };

  const handleRevokeKey = async (id: string) => {
    await apiFetch(`/api/admin/keys/${id}`, { method: 'DELETE' });
    await onRefresh();
  };

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantName.trim() || !tenantSlug.trim()) return;
    await apiFetch('/api/admin/tenants', {
      method: 'POST',
      body: JSON.stringify({
        name: tenantName.trim(),
        slug: tenantSlug.trim().toLowerCase(),
        workspace_language: tenantLang,
        rate_limit_rpm: 180,
        pii_redaction: false,
      }),
    });
    setTenantName('');
    setTenantSlug('');
    await onRefresh();
  };

  const handleTogglePii = async (tenantId: string, current: boolean) => {
    await apiFetch(`/api/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pii_redaction: !current }),
    });
    await onRefresh();
  };

  const handlePreviewWebhook = async (tenantId: string) => {
    const res = await apiFetch<{ header: string; payload: string }>(`/api/admin/tenants/${tenantId}/sign-webhook-preview`, {
      method: 'POST',
      body: JSON.stringify({ payload: { event: 'business.analysis.completed', tenantId } }),
    });
    setWebhookPreview(`X-Neo-Signature: ${res.header}\nPayload: ${res.payload}`);
  };

  return (
    <div className="space-y-8">
      {/* Admin Access & Lock Setup */}
      <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Admin Console Access Control</h2>
            <p className="mt-1 text-xs text-slate-400">
              Status: {data.lockState.source === 'unclaimed' ? 'Preview Mode (Unclaimed)' : `Protected (${data.lockState.source})`}
              {getAdminToken() ? ' · Session Active' : ''}
            </p>
          </div>
        </div>

        <form onSubmit={data.lockState.locked ? handleLoginAdmin : handleClaimAdmin} className="flex flex-col sm:flex-row gap-3">
          <label className="sr-only" htmlFor="admin-passcode-input">Admin passcode</label>
          <input
            id="admin-passcode-input"
            type="password"
            value={passcodeInput}
            onChange={(e) => setPasscodeInput(e.target.value)}
            placeholder={
              data.lockState.locked
                ? 'Enter admin passcode to refresh session...'
                : 'Claim initial admin passcode (min 6 chars) to lock console...'
            }
            className="flex-1 px-3 py-2 text-sm bg-[#0B0F17] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={passcodeInput.length < 6}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {data.lockState.locked ? 'Authenticate Session' : 'Claim & Lock Admin'}
          </button>
        </form>
        {authMsg && <p className="text-xs text-emerald-400">{authMsg}</p>}
        {authErr && <p className="text-xs text-rose-400">{authErr}</p>}
      </section>

      {/* Scoped API Keys */}
      <section className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-sm font-semibold text-slate-100">Scoped Neos API Keys</h2>
            <p className="mt-1 text-xs text-slate-400">Keys are hashed with SHA-256 at rest. Plaintext secrets are shown once upon creation.</p>
          </div>
          <form onSubmit={handleCreateKey} className="flex flex-wrap items-center gap-2">
            <select
              value={selectedTenantId}
              onChange={(e) => setSelectedTenantId(e.target.value)}
              aria-label="Select tenant for API key"
              className="px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
            >
              {data.tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              aria-label="API key label"
              className="px-3 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
            />
            <button
              type="submit"
              className="px-3.5 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              Issue Key
            </button>
          </form>
        </div>

        {newRawKey && (
          <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono text-emerald-300 flex items-center justify-between gap-4">
            <span className="truncate">Issued Key (copy now): {newRawKey}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(newRawKey)}
              className="px-2.5 py-1 rounded bg-emerald-600 text-white shrink-0"
            >
              Copy
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Prefix</th>
                <th className="py-2 font-medium">Scopes</th>
                <th className="py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data.apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-slate-500">No API keys issued yet. Click &ldquo;Issue Key&rdquo; to generate a neos_live_ credential.</td>
                </tr>
              ) : (
                data.apiKeys.map((k) => (
                  <tr key={k.id} className="h-10">
                    <td className="py-2 text-slate-200 font-medium">{k.name}</td>
                    <td className="py-2 font-mono text-slate-400">{k.key_prefix}...</td>
                    <td className="py-2 font-mono text-slate-400">{k.scopes.join(', ')}</td>
                    <td className="py-2 text-right">
                      {k.revoked_at ? (
                        <span className="text-rose-400 font-mono">revoked</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRevokeKey(k.id)}
                          className="text-rose-400 hover:underline"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Multi-Tenant Workspaces & HMAC Webhook Signing */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">Neos Workspaces & Privacy</h2>
          <form onSubmit={handleCreateTenant} className="flex flex-wrap gap-2">
            <input
              type="text"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder="Workspace Name"
              aria-label="Tenant name"
              className="flex-1 min-w-[140px] px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
            />
            <input
              type="text"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              placeholder="slug-id"
              aria-label="Tenant slug"
              className="w-28 px-2.5 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100 font-mono"
            />
            <select
              value={tenantLang}
              onChange={(e) => setTenantLang(e.target.value as 'en' | 'fa' | 'ar' | 'nl')}
              aria-label="Workspace language"
              className="px-2 py-1.5 text-xs bg-[#0B0F17] border border-slate-700 rounded-md text-slate-100"
            >
              <option value="en">EN</option>
              <option value="fa">FA</option>
              <option value="ar">AR</option>
              <option value="nl">NL</option>
            </select>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 text-slate-100 hover:bg-slate-700"
            >
              Add Tenant
            </button>
          </form>

          <div className="divide-y divide-slate-800/60">
            {data.tenants.map((t) => (
              <div key={t.id} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <p className="font-medium text-slate-100">{t.name}</p>
                  <p className="text-slate-500 font-mono">
                    {t.slug} · lang={t.workspace_language} · {t.rate_limit_rpm} rpm
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleTogglePii(t.id, t.pii_redaction)}
                    className={`px-2.5 py-1 rounded text-xs font-medium ${
                      t.pii_redaction ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    PII Redact: {t.pii_redaction ? 'On' : 'Off'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreviewWebhook(t.id)}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
                  >
                    Test HMAC
                  </button>
                </div>
              </div>
            ))}
          </div>
          {webhookPreview && (
            <pre className="p-2.5 rounded bg-[#0B0F17] border border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto">
              {webhookPreview}
            </pre>
          )}
        </div>

        <div className="bg-[#111827] border border-slate-800/80 rounded-lg p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold text-slate-100">Recent Gateway Audit Logs</h2>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 font-medium">Action</th>
                  <th className="py-2 font-medium">Actor</th>
                  <th className="py-2 font-medium text-right">HTTP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {data.auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-4 text-slate-500">No gateway calls audited yet.</td>
                  </tr>
                ) : (
                  data.auditLogs.slice(0, 15).map((log) => (
                    <tr key={log.id} className="h-9">
                      <td className="py-2 font-mono text-slate-200">{log.action}</td>
                      <td className="py-2 font-mono text-slate-400">{log.actor}</td>
                      <td className={`py-2 text-right font-mono tabular-nums ${log.status_code < 400 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {log.status_code}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
