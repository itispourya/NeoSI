import { useState } from 'react';
import { apiFetch } from '../lib/api';
import type { AdminOverviewPayload } from '../types/neo';

interface SecurityViewProps {
  data: AdminOverviewPayload;
  onRefresh: () => Promise<void>;
}

export function SecurityView({ data, onRefresh }: SecurityViewProps) {
  const [keyTenantId, setKeyTenantId] = useState(data.tenants[0]?.id || 'global');
  const [keyName, setKeyName] = useState('');
  const [newRawKey, setNewRawKey] = useState<string | null>(null);

  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNewRawKey(null);
    try {
      const res = await apiFetch<{ rawKey: string }>('/api/admin/keys', {
        method: 'POST',
        body: JSON.stringify({ tenantId: keyTenantId, name: keyName, scopes: ['read', 'write', 'forge'] }),
      });
      setNewRawKey(res.rawKey);
      setKeyName('');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Key creation failed');
    }
  };

  const rotateKey = async (id: string) => {
    setError(null);
    try {
      const res = await apiFetch<{ rawKey: string }>(`/api/admin/keys/${id}/rotate`, { method: 'POST', body: '{}' });
      setNewRawKey(res.rawKey);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Key rotation failed');
    }
  };

  const revokeKey = async (id: string) => {
    setError(null);
    try {
      await apiFetch(`/api/admin/keys/${id}`, { method: 'DELETE' });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Key revocation failed');
    }
  };

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify({ name: tenantName, slug: tenantSlug, workspace_language: 'en', rate_limit_rpm: 120, pii_redaction: true }),
      });
      setTenantName('');
      setTenantSlug('');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Tenant creation failed');
    }
  };

  return (
    <div className="space-y-6">
      {error && <div className="p-3 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>}
      {newRawKey && (
        <div className="p-4 rounded bg-emerald-500/10 border border-emerald-500/40 text-xs font-mono space-y-1">
          <div className="text-emerald-300 font-semibold">New API Key (shown once — copy now):</div>
          <div className="text-slate-100 break-all select-all">{newRawKey}</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={createKey} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Issue Scoped API Key</h2>
          <select
            value={keyTenantId}
            onChange={(e) => setKeyTenantId(e.target.value)}
            className="w-full px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-200"
          >
            {data.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.slug})
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key label e.g. Neos Production"
              required
              className="flex-1 px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap shrink-0"
            >
              Issue Key
            </button>
          </div>

          <div className="divide-y divide-slate-800/80 pt-2">
            {data.apiKeys.map((k) => (
              <div key={k.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{k.name}</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    {k.key_prefix}*** · [{k.scopes.join(', ')}] {k.revoked_at ? '· REVOKED' : ''}
                  </div>
                </div>
                {!k.revoked_at && (
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void rotateKey(k.id)}
                      className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-[11px] text-slate-300 whitespace-nowrap"
                    >
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => void revokeKey(k.id)}
                      className="px-2 py-1 rounded border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-[11px] whitespace-nowrap"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </form>

        <form onSubmit={createTenant} className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
          <h2 className="font-display text-sm font-semibold text-slate-100">Isolated Workspaces / Tenants ({data.tenants.length})</h2>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder="Workspace Name"
              required
              className="px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs text-slate-100"
            />
            <input
              type="text"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              placeholder="slug-name"
              required
              pattern="[a-z0-9-]+"
              className="px-3 py-2 bg-[#0B0F17] border border-slate-700 rounded text-xs font-mono text-slate-100"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
          >
            Create Isolated Tenant
          </button>

          <div className="divide-y divide-slate-800/80 pt-2">
            {data.tenants.map((t) => (
              <div key={t.id} className="py-2 flex items-center justify-between text-xs">
                <div>
                  <div className="text-slate-200 font-medium">{t.name}</div>
                  <div className="font-mono text-[11px] text-slate-400">
                    slug={t.slug} · lang={t.workspace_language} · pii={t.pii_redaction ? 'on' : 'off'} · {t.rate_limit_rpm} rpm
                  </div>
                </div>
              </div>
            ))}
          </div>
        </form>
      </div>

      <div className="bg-[#111827] border border-slate-800 rounded p-5 space-y-3">
        <h3 className="font-display text-sm font-semibold text-slate-100">Security & Gateway Audit Log</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Resource</th>
                <th className="py-2 pr-4">Tenant</th>
                <th className="py-2 pr-4">Actor</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {data.auditLogs.slice(0, 15).map((log) => (
                <tr key={log.id}>
                  <td className="py-2 pr-4 text-slate-200">{log.action}</td>
                  <td className="py-2 pr-4 text-slate-400">{log.resource}</td>
                  <td className="py-2 pr-4 text-slate-400">{log.tenant_id}</td>
                  <td className="py-2 pr-4 text-slate-400">{log.actor}</td>
                  <td className="py-2 tabular-nums text-emerald-400">{log.status_code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
