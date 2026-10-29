import { useEffect, useState } from 'react';
import { api, fmtMoney2 } from '../api';
import { PageHeader, Skeleton, EmptyState } from '../components/ui';
import { useToast } from '../components/ui';
import RescueWizard from '../components/RescueWizard';
import ImportWizard from '../components/ImportWizard';

const TYPE_META = {
  followup: { icon: '⏰', label: 'Follow-up', color: 'border-l-amber-400', bg: 'bg-amber-50' },
  filing: { icon: '📅', label: 'Filing deadline', color: 'border-l-rose-400', bg: 'bg-rose-50' },
  denial: { icon: '⚠️', label: 'Unworked denial', color: 'border-l-orange-400', bg: 'bg-orange-50' },
  stale: { icon: '💤', label: 'Stale A/R', color: 'border-l-stone-400', bg: 'bg-stone-50' },
};

export default function MyWork({ onOpenAppeal, onOpenClaim, onStartAppeal, onReviewAgentDrafts }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [scope, setScope] = useState('all');
  const [doneKeys, setDoneKeys] = useState(new Set());
  const [rescueClaimId, setRescueClaimId] = useState(null);
  const [showImport, setShowImport] = useState(false);

  const load = () => api.worklist(scope).then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, [scope]);

  const handleAction = async (item) => {
    if (item.action.kind === 'appeal') onOpenAppeal(item.action.id);
    else if (item.action.kind === 'start-appeal') onStartAppeal(item.claim_id);
    else if (item.action.kind === 'claim') onOpenClaim(item.claim_id);
  };

  const markDone = async (item) => {
    try {
      if (item.claim_id) await api.touchClaim(item.claim_id);
      setDoneKeys((s) => new Set(s).add(item.key));
      toast.success('Marked as worked');
    } catch (e) { toast.error(e.message); }
  };

  const visible = data?.items.filter((i) => !doneKeys.has(i.key)) || [];

  return (
    <div>
      <PageHeader
        title="My Work"
        subtitle={data ? `${visible.length} items prioritized for you · ${fmtMoney2(data.summary.totalAtStake)} total at stake` : 'Your prioritized daily queue'}
        actions={[
          <button key="import" className="btn btn-dark" onClick={() => setShowImport(true)}>🧾 Import claims</button>,
          <div key="scope" className="flex gap-1 bg-white border border-stone-200 rounded-xl p-1">
            {[['all', 'Team queue'], ['mine', 'Assigned to me']].map(([v, l]) => (
              <button key={v} onClick={() => setScope(v)}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${scope === v ? 'bg-stone-900 text-white' : 'text-stone-500 hover:text-stone-800'}`}>
                {l}
              </button>
            ))}
          </div>,
        ]}
      />

      {!data ? (
        <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}</div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState icon="🎉" title={doneKeys.size > 0 ? 'Queue cleared — nice work!' : 'Nothing needs your attention'}
            hint="Every follow-up is current, no filing deadlines at risk, and every denial has an appeal. Come back tomorrow." />
        </div>
      ) : (
        <>
          {data.summary.filingAtRisk > 0 && (
            <div className="mb-4 flex items-center gap-3 bg-rose-50 border border-rose-200 rounded-2xl px-5 py-3.5">
              <span className="text-xl">🚨</span>
              <span className="text-sm text-rose-900">
                <strong>{data.summary.filingAtRisk} claims</strong> are at or past their timely filing deadline.
                <span className="text-rose-700"> Work these first — expired deadlines mean unrecoverable revenue.</span>
              </span>
            </div>
          )}

          <div className="space-y-3">
            {visible.map((item) => {
              const meta = TYPE_META[item.type];
              return (
                <div key={item.key}
                  className={`card p-5 border-l-4 ${meta.color} hover:shadow-md transition-shadow flex items-center gap-4`}>
                  <div className={`w-11 h-11 rounded-xl ${meta.bg} flex items-center justify-center text-xl shrink-0`}>
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-stone-900">{item.title}</span>
                      <span className="badge badge-slate">{meta.label}</span>
                      {item.urgent && <span className="badge badge-rose">Urgent</span>}
                    </div>
                    <div className="text-sm text-stone-500 mt-0.5">{item.subtitle}</div>
                    <div className="text-[13px] text-stone-600 mt-1.5 flex items-center gap-1.5">
                      <span className="text-stone-400">→</span> {item.reason}
                    </div>
                    {item.prediction && (
                      <div className="mt-1.5">
                        <span
                          title={`${item.prediction.detail}${item.prediction.label === 'early estimate' ? ' — early estimate (thin history)' : ''}`}
                          className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2 py-0.5 border ${item.prediction.value >= 0.5 ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>
                          🤖 {item.prediction.headline} · n={item.prediction.sampleSize}
                          {item.prediction.label === 'early estimate' && <span className="text-amber-600">· early estimate</span>}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0 hidden sm:block">
                    <div className="text-lg font-bold text-stone-900">{fmtMoney2(item.amount)}</div>
                    <div className="text-[11px] text-stone-400 uppercase tracking-wide">at stake</div>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <button onClick={() => handleAction(item)} className="btn btn-primary !py-2 !text-[13px]">
                      {item.action.label} →
                    </button>
                    {item.type === 'denial' && item.claim_id && (
                      <button onClick={() => setRescueClaimId(item.claim_id)} className="btn btn-dark !py-1.5 !text-xs">
                        🛟 Rescue
                      </button>
                    )}
                    <button onClick={() => markDone(item)} className="btn btn-ghost !py-1.5 !text-xs">
                      ✓ Mark worked
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {doneKeys.size > 0 && (
            <div className="mt-4 text-center text-sm text-stone-500">
              {doneKeys.size} item{doneKeys.size > 1 ? 's' : ''} worked this session 🎉
            </div>
          )}
        </>
      )}
      {rescueClaimId && (
        <RescueWizard claimId={rescueClaimId} onClose={() => setRescueClaimId(null)} onReviewDrafts={onReviewAgentDrafts} />
      )}
      {showImport && (
        <ImportWizard onClose={() => setShowImport(false)} onImported={load} />
      )}
    </div>
  );
}
