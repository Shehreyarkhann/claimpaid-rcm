import { useEffect, useState } from 'react';
import { authFetch } from '../auth';
import { PageHeader, Skeleton, EmptyState } from '../components/ui';
import { useToast } from '../components/ui';

const ACTION_COLORS = {
  view: 'badge-blue', export: 'badge-violet', create: 'badge-green',
  update: 'badge-amber', delete: 'badge-rose',
};

export default function AuditLog() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [days, setDays] = useState(30);
  const [userFilter, setUserFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const load = () => {
    const q = new URLSearchParams({ days, user: userFilter, action: actionFilter });
    authFetch(`/api/audit?${q}`).then((r) => r.json()).then(setRows).catch((e) => toast.error(e.message));
    authFetch(`/api/audit/summary?days=${days}`).then((r) => r.json()).then(setSummary).catch(() => {});
  };
  useEffect(() => { load(); }, [days]);

  return (
    <div>
      <PageHeader
        title="Audit Log"
        subtitle="HIPAA access record — who viewed or exported patient data, and when"
      />

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="card p-5">
            <div className="text-3xl font-bold text-stone-900">{summary.byAction.reduce((a, r) => a + r.n, 0).toLocaleString()}</div>
            <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">Total events</div>
            <div className="text-[11px] text-stone-400">Last {summary.periodDays} days</div>
          </div>
          {summary.byAction.slice(0, 3).map((a) => (
            <div key={a.action} className="card p-5">
              <div className="text-3xl font-bold text-stone-900">{a.n.toLocaleString()}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">{a.action}s</div>
              <div className="text-[11px] text-stone-400">of PHI records</div>
            </div>
          ))}
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-3 items-end mb-5">
        <div><label className="label">Period</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input !w-auto">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select></div>
        <div><label className="label">User</label>
          <input value={userFilter} onChange={(e) => setUserFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Email or name…" className="input" /></div>
        <div><label className="label">Action</label>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            <option value="view">Views</option>
            <option value="export">Exports</option>
          </select></div>
        <button onClick={load} className="btn btn-dark">Filter</button>
      </div>

      <div className="card overflow-hidden">
        {!rows ? (
          <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon="📋" title="No audit events"
            hint="Views and exports of patient records will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl min-w-[760px]">
              <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>IP</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="text-[13px] text-stone-500 whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </td>
                    <td>
                      <div className="font-medium text-[13px]">{r.user_name || '—'}</div>
                      <div className="text-[11px] text-stone-400">{r.user_email}</div>
                    </td>
                    <td><span className={`badge ${ACTION_COLORS[r.action] || 'badge-slate'}`}>{r.action}</span></td>
                    <td>
                      <div className="text-[13px]"><span className="text-stone-400">{r.resource_type}</span> <span className="font-mono font-medium">{r.resource_label || r.resource_id || '—'}</span></div>
                    </td>
                    <td className="text-[12px] text-stone-400 font-mono">{r.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-xs text-stone-400 mt-4">
        Audit events are append-only and retained per your data retention policy. Export this table for compliance reviews.
      </p>
    </div>
  );
}
