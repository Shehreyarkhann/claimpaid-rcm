import { useEffect, useState, useRef } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney } from '../api';
import { PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

const ACTION_LABELS = {
  created: 'created', updated: 'updated', touched: 'worked',
  payment_posted: 'posted payment on', appeal_opened: 'opened appeal on',
};

export default function Digest() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [eraResult, setEraResult] = useState(null);
  const fileRef = useRef(null);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  useEffect(() => {
    api.digest().then(setData).catch((e) => toast.error(e.message));
    // Auto-escalation runs silently each morning with the briefing
    authFetch('/api/analytics/escalate', { method: 'POST' }).catch(() => {});
  }, []);

  const handle835 = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true); setEraResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await authFetch('/api/era/upload-835', { method: 'POST', body: fd });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      setEraResult(result);
      toast.success(`835 processed: ${result.matched} claims matched`);
      api.digest().then(setData).catch(() => {});
    } catch (err) {
      setEraResult({ error: err.message });
      toast.error(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  return (
    <div>
      <PageHeader
        title="Daily Briefing"
        subtitle={`${greeting()}, ${user?.name?.split(' ')[0]} — here's what needs you today`}
        actions={canWrite ? [
          <button key="835" className="btn btn-outline" disabled={uploading} onClick={() => fileRef.current.click()}>
            {uploading ? 'Processing…' : '⬆ Upload 835 ERA'}
          </button>,
        ] : []}
      />
      <input ref={fileRef} type="file" accept=".835,.txt,.dat" className="hidden" onChange={handle835} />

      {eraResult && !eraResult.error && (
        <div className="card p-5 mb-5 !border-emerald-200 bg-emerald-50/50">
          <div className="font-semibold text-stone-900 mb-1">835 processed — {eraResult.file}</div>
          <div className="text-sm text-stone-600">
            {eraResult.payer && <>Payer: <strong>{eraResult.payer}</strong> · </>}
            {eraResult.checkNumber && <>Check/EFT: <strong>{eraResult.checkNumber}</strong> · </>}
            {eraResult.payDate && <>Date: <strong>{eraResult.payDate}</strong></>}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {[['Matched', eraResult.matched, 'text-stone-700'], ['Paid in full', eraResult.paid, 'text-emerald-700'],
              ['Partial', eraResult.partial, 'text-amber-700'], ['Denied', eraResult.denied, 'text-rose-700']].map(([l, v, c]) => (
              <div key={l} className="bg-white rounded-xl border border-stone-200 p-3 text-center">
                <div className={`text-2xl font-bold ${c}`}>{v}</div>
                <div className="text-xs text-stone-500">{l}</div>
              </div>
            ))}
          </div>
          {eraResult.unmatched.length > 0 && (
            <div className="text-xs text-amber-700 mt-3">
              {eraResult.unmatched.length} claim IDs not found in your system: {eraResult.unmatched.slice(0, 5).join(', ')}
              {eraResult.unmatched.length > 5 && ` +${eraResult.unmatched.length - 5} more`}
            </div>
          )}
          <button onClick={() => setEraResult(null)} className="text-xs text-stone-500 underline mt-3">dismiss</button>
        </div>
      )}
      {eraResult?.error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700 mb-5">
          835 upload failed: {eraResult.error}
          <button onClick={() => setEraResult(null)} className="ml-3 underline">dismiss</button>
        </div>
      )}

      {!data ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : (
        <>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="card p-5 border-l-4 !border-l-amber-400">
              <div className="text-3xl font-bold text-stone-900">{data.overdueFollowups}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">Overdue follow-ups</div>
            </div>
            <div className="card p-5 border-l-4 !border-l-rose-400">
              <div className="text-3xl font-bold text-stone-900">{data.filingCritical.count}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">Filing deadlines ≤ 14d</div>
              <div className="text-xs text-rose-600 mt-1 font-medium">{fmtMoney(data.filingCritical.amount)} at stake</div>
            </div>
            <div className="card p-5 border-l-4 !border-l-orange-400">
              <div className="text-3xl font-bold text-stone-900">{data.unworkedDenials.count}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">Unworked denials</div>
              <div className="text-xs text-stone-500 mt-1">{fmtMoney(data.unworkedDenials.amount)} waiting</div>
            </div>
            <div className="card p-5 border-l-4 !border-l-emerald-400">
              <div className="text-3xl font-bold text-emerald-700">{fmtMoney(data.recoveredThisWeek.amount)}</div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">Recovered this week</div>
              <div className="text-xs text-stone-500 mt-1">{data.recoveredThisWeek.count} appeals won</div>
            </div>
          </div>

          {(data.authAlerts?.expiring?.length > 0 || (data.authAlerts?.staleWaiting || 0) > 0) && (
            <div className="card p-6 mb-6 !border-amber-200 bg-amber-50/40">
              <h3 className="font-semibold text-stone-900 mb-3">⚠️ Prior authorization alerts</h3>
              <div className="space-y-2">
                {data.authAlerts.expiring.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm bg-white rounded-xl border border-amber-100 px-4 py-2.5">
                    <span><strong>{a.patient_name}</strong> <span className="text-stone-500">· auth #{a.id} · valid through {a.valid_to}</span></span>
                    <span className={`badge ${a.days_left < 0 ? 'badge-rose' : a.days_left <= 7 ? 'badge-rose' : 'badge-amber'}`}>
                      {a.days_left < 0 ? 'Expired' : `${a.days_left}d left`}
                    </span>
                  </div>
                ))}
                {data.authAlerts.staleWaiting > 0 && (
                  <div className="text-sm text-amber-800 px-1 pt-1">
                    {data.authAlerts.staleWaiting} auth request{data.authAlerts.staleWaiting === 1 ? '' : 's'} waiting on payer for 10+ days — time to call.
                  </div>
                )}
              </div>
            </div>
          )}

          {(data.denialPatterns?.length > 0 || (data.unappealedDenials?.count || 0) > 0) && (
            <div className="card p-6 mb-6 !border-rose-200 bg-rose-50/30">
              <h3 className="font-semibold text-stone-900 mb-1">🔍 Denial patterns detected</h3>
              <p className="text-xs text-stone-500 mb-3">Same payer denying the same way, repeatedly — fix the root cause, not just the claims</p>
              <div className="space-y-2">
                {data.denialPatterns?.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-sm bg-white rounded-xl border border-rose-100 px-4 py-2.5">
                    <span><strong>{p.payer}</strong> <span className="text-stone-500">· {p.denial_reason}</span></span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-stone-500">{p.n} claims · ${p.at_stake.toLocaleString()} at stake</span>
                    </span>
                  </div>
                ))}
                {(data.unappealedDenials?.count || 0) > 0 && (
                  <div className="text-sm text-rose-800 px-1 pt-1 font-medium">
                    {data.unappealedDenials.count} denied claims have no appeal after 14+ days — ${data.unappealedDenials.amount.toLocaleString()} sitting idle.
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card p-6">
            <h3 className="font-semibold text-stone-900 mb-4">Recent team activity</h3>
            {data.recentActivity.length === 0 ? (
              <div className="text-sm text-stone-400">No activity in the last 24 hours. Quiet day — or nobody's logging their work.</div>
            ) : (
              <div className="space-y-3">
                {data.recentActivity.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm">
                    <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-500 shrink-0">
                      {(a.user_name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2)}
                    </div>
                    <div className="flex-1">
                      <strong>{a.user_name || 'Someone'}</strong> {ACTION_LABELS[a.action] || a.action}
                      {a.claim_number && <span className="font-mono text-xs text-stone-500"> {a.claim_number}</span>}
                      {a.detail && <span className="text-stone-500"> — {a.detail}</span>}
                    </div>
                    <div className="text-xs text-stone-400 shrink-0">
                      {new Date(a.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
