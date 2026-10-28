import { useEffect, useRef, useState } from 'react';
import { api, fmtMoney } from '../api';

// Agent insights card (Phase 3) — renders /api/agent/insights: filing-risk
// dollars, expected collections, denial-trend watch, exception backlog.
// Every figure is computed server-side from this workspace's own data by
// the prediction service; thin samples carry their "early estimate" label
// rather than dressing up as precision. When the agent is disabled the
// endpoint answers AGENT_DISABLED and this card renders NOTHING at all.
//
// Phase 4: the recovered band leads the card — dollars actually collected
// on claims whose agent-drafted appeal was approved and overturned,
// counted up on first render (settled instantly for reduced motion).

// Tiny rAF count-up (no library). Reduced-motion users — and jsdom-like
// environments without rAF — get the final figure immediately.
function useCountUp(target, duration = 850) {
  const [value, setValue] = useState(0);
  const rafRef = useRef(null);
  useEffect(() => {
    const end = Number(target) || 0;
    if (!end || typeof requestAnimationFrame !== 'function'
      || (typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      setValue(end);
      return undefined;
    }
    const start = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(end * eased * 100) / 100);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);
  return value;
}

export default function AgentInsights() {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    api.agent.insights()
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live && e && e.code === 'AGENT_DISABLED') setHidden(true); });
    return () => { live = false; };
  }, []);

  const recoveredAmount = useCountUp(data?.recovered_via_agent_appeals?.amount || 0);

  if (hidden || !data) return null;

  const recovered = data.recovered_via_agent_appeals || { amount: 0, appeals: 0 };
  const risk = data.filing_risk_14d || { claims: 0, amount: 0 };
  const expected = data.expected_collections_30d || { amount: 0, claims_with_estimate: 0, open_claims: 0, label: 'no data yet', note: '' };
  const watch = data.denial_trend_watch || [];
  const backlog = data.exception_backlog || { count: 0, amount: 0 };

  return (
    <div className="card p-5 mb-6">
      <div className="flex items-baseline gap-3 flex-wrap mb-4">
        <span className="text-xl">🤖</span>
        <h3 className="font-display font-semibold text-stone-900 text-lg">Agent insights</h3>
        <span className="text-xs text-stone-400">Predictions from this workspace's own decided claims and remittances</span>
      </div>
      <div className="rounded-xl bg-emerald-700 px-4 py-3.5 mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="motion-count-up font-display text-2xl font-semibold text-white">{fmtMoney(recoveredAmount)}</span>
        <span className="text-sm font-medium text-emerald-50">Recovered via agent-assisted appeals</span>
        <span className="text-xs text-emerald-200">
          {recovered.appeals > 0
            ? `${recovered.appeals} overturned appeal${recovered.appeals === 1 ? '' : 's'} drafted by the agent and approved by a person — dollars collected, not billed`
            : 'No agent-assisted recoveries yet — the first approved draft that overturns starts the count'}
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3.5 py-3">
          <div className="font-display text-xl font-semibold text-rose-700">{fmtMoney(risk.amount)}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500 mt-0.5">At filing risk · 14 days</div>
          <div className="text-[11px] text-stone-400 mt-0.5">{risk.claims} claim{risk.claims === 1 ? '' : 's'} at or near deadline</div>
        </div>
        <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3.5 py-3">
          <div className="font-display text-xl font-semibold text-emerald-700">{fmtMoney(expected.amount)}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500 mt-0.5">Expected collections · 30 days</div>
          <div className="text-[11px] text-stone-400 mt-0.5">
            From {expected.claims_with_estimate} of {expected.open_claims} open claims
            {expected.label === 'early estimate' && <span className="text-amber-700 font-medium"> · early estimate</span>}
            {expected.label === 'no data yet' && <span> · no payment history yet</span>}
          </div>
        </div>
        <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3.5 py-3">
          <div className="font-display text-xl font-semibold text-stone-900">{backlog.count}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500 mt-0.5">ERA exceptions open</div>
          <div className="text-[11px] text-stone-400 mt-0.5">{fmtMoney(backlog.amount)} waiting on a decision</div>
        </div>
        <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3.5 py-3">
          <div className="font-display text-xl font-semibold text-stone-900">{watch.length}</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500 mt-0.5">Payers on denial watch</div>
          <div className="text-[11px] text-stone-400 mt-0.5">Denial rate up vs the prior 30 days</div>
        </div>
      </div>
      {watch.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {watch.map((w) => (
            <div key={w.payer} className="flex items-baseline gap-2 text-sm">
              <span className="badge badge-rose shrink-0">▲ {w.delta_points} pts</span>
              <span className="min-w-0">
                <span className="font-medium text-stone-800">{w.payer}</span>
                <span className="text-stone-500"> — denial rate {Math.round(w.current_rate * 100)}% in the last 30 days (was {Math.round(w.prior_rate * 100)}%, n={w.sample_size}{w.label === 'early estimate' ? ', early estimate' : ''})</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {expected.note && <p className="text-[11px] text-stone-400 mt-3">{expected.note}</p>}
    </div>
  );
}
