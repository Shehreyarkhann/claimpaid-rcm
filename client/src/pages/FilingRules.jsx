import { useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { api } from '../api';
import { PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

export default function FilingRules() {
  const { user } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState({});
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const load = () => api.filingRules().then(setRules).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const save = async (payerId) => {
    const days = parseInt(editing[payerId]);
    if (!days || days < 1 || days > 730) { toast.error('Enter 1–730 days'); return; }
    try {
      await api.setFilingRule(payerId, days, null);
      toast.success('Filing rule updated');
      setEditing((e) => { const n = { ...e }; delete n[payerId]; return n; });
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <PageHeader
        title="Timely Filing Rules"
        subtitle="How many days from date of service each payer allows. Deadlines drive the work queue and risk alerts."
      />

      <div className="card p-5 mb-5 bg-gradient-to-r from-sky-50 to-emerald-50 !border-sky-100">
        <div className="text-sm font-semibold text-slate-800 mb-1">Why this matters</div>
        <p className="text-sm text-slate-600 leading-relaxed">
          Every payer sets its own clock from the date of service. Miss it and the claim is denied with no appeal rights —
          the revenue is gone permanently. These deadlines power the <strong>My Work</strong> queue prioritization and the
          filing-risk alerts on your dashboard. Defaults are industry-standard; adjust them to match your payer contracts.
        </p>
      </div>

      {!rules ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full tbl">
            <thead><tr><th>Payer</th><th>Type</th><th>Filing deadline</th>{canWrite && <th className="!text-right">Edit</th>}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.payer_id}>
                  <td className="font-medium">{r.payer}</td>
                  <td><span className="badge badge-slate">{r.type}</span></td>
                  <td>
                    {editing[r.payer_id] !== undefined ? (
                      <span className="text-sm font-semibold text-slate-700">{editing[r.payer_id] || '—'} days</span>
                    ) : (
                      <span className="text-sm">
                        <strong className="text-slate-900">{r.filing_days} days</strong>
                        {r.is_default && <span className="ml-2 text-[11px] text-slate-400">(default)</span>}
                      </span>
                    )}
                  </td>
                  {canWrite && (
                    <td className="!text-right">
                      {editing[r.payer_id] !== undefined ? (
                        <div className="flex items-center justify-end gap-2">
                          <input type="number" min="1" max="730" autoFocus
                            className="input !w-24 !py-1.5"
                            value={editing[r.payer_id]}
                            onChange={(e) => setEditing({ ...editing, [r.payer_id]: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && save(r.payer_id)} />
                          <button onClick={() => save(r.payer_id)} className="btn btn-primary !py-1.5 !text-xs">Save</button>
                          <button onClick={() => setEditing((e) => { const n = { ...e }; delete n[r.payer_id]; return n; })}
                            className="btn btn-ghost !py-1.5 !text-xs">Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => setEditing({ ...editing, [r.payer_id]: r.filing_days })}
                          className="text-sky-600 hover:text-sky-800 text-xs font-semibold">Edit</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
