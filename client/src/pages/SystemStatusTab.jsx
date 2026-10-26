import { useCallback, useEffect, useRef, useState } from 'react';
import incidentsData from '../data/incidents.json';

// Superadmin-only system status (a tab inside the /super console — never
// linked publicly). Probes the RCM + AI health endpoints and renders the
// incident log from the bundled incidents.json.

const COMPONENTS = [
  { id: 'rcm', name: 'ClaimPaid RCM app', url: '/api/health' },
  { id: 'ai', name: 'ClaimPaid AI', url: '/ai/api/health' },
  { id: 'web', name: 'Website', url: null }, // this console loaded = website works
];

const DOT = {
  ok: 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,.8)]',
  degraded: 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,.8)]',
  down: 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,.8)]',
  checking: 'bg-stone-600',
};
const LABEL = { ok: 'Operational', degraded: 'Degraded', down: 'Down', checking: 'Checking…' };
const ST_BADGE = {
  resolved: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  monitoring: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  investigating: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
  identified: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};

async function probe(c) {
  if (!c.url) return { state: 'ok', ms: null, note: "you're reading it" };
  const t0 = performance.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(c.url, { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return { state: 'down', ms, note: 'HTTP ' + r.status };
    let body = null;
    try { body = await r.json(); } catch (e) { /* non-JSON */ }
    return body && body.status === 'ok'
      ? { state: 'ok', ms }
      : { state: 'degraded', ms, note: 'unexpected response' };
  } catch (e) {
    return { state: 'down', ms: null, note: 'no response' };
  }
}

export default function SystemStatusTab() {
  const [results, setResults] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);
  const timer = useRef(null);

  const runChecks = useCallback(async () => {
    setResults(Object.fromEntries(COMPONENTS.map((c) => [c.id, { state: 'checking' }])));
    const out = {};
    await Promise.all(COMPONENTS.map(async (c) => { out[c.id] = await probe(c); }));
    setResults(out);
    setLastChecked(new Date());
  }, []);

  useEffect(() => {
    runChecks();
    timer.current = setInterval(runChecks, 60000);
    return () => clearInterval(timer.current);
  }, [runChecks]);

  const worst = results
    ? Object.values(results).some((r) => r.state === 'down') ? 'down'
      : Object.values(results).some((r) => r.state === 'degraded') ? 'degraded' : 'ok'
    : 'checking';

  const incidents = (incidentsData.incidents || []).slice().reverse();

  return (
    <div className="max-w-3xl">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 flex items-center gap-4 mb-4">
        <span className={`w-3.5 h-3.5 rounded-full shrink-0 ${DOT[worst]}`} />
        <div>
          <div className="text-lg font-bold text-white">
            {worst === 'checking' ? 'Checking systems…' : worst === 'ok' ? 'All systems operational' : worst === 'degraded' ? 'Some systems degraded' : 'Some systems down'}
          </div>
          <div className="text-sm text-stone-400">
            {worst === 'ok' ? 'Everything is running normally.' : worst === 'checking' ? 'Probing each service now.' : 'You are aware — this page is only visible to you.'}
          </div>
        </div>
      </div>

      <div className="grid gap-3 mb-2">
        {COMPONENTS.map((c) => {
          const r = results?.[c.id] || { state: 'checking' };
          return (
            <div key={c.id} className="bg-stone-900 border border-stone-800 rounded-xl px-5 py-4 flex items-center gap-4">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${DOT[r.state]}`} />
              <div>
                <div className="font-bold text-white text-[15px]">{c.name}</div>
                <div className="text-xs text-stone-400 mt-0.5">{LABEL[r.state]}{r.note ? ` — ${r.note}` : ''}</div>
              </div>
              <span className="ml-auto text-xs text-stone-500 whitespace-nowrap">{r.ms == null ? '' : `${r.ms} ms`}</span>
            </div>
          );
        })}
      </div>

      <div className="text-xs text-stone-500 mt-4 mb-8">
        {lastChecked ? `Last checked ${lastChecked.toLocaleTimeString()}` : ''} ·{' '}
        <button onClick={runChecks} className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2">Refresh now</button>
        {' '}· auto-refreshes every 60 seconds
      </div>

      <h2 className="text-base font-bold text-white mb-3">Incident history</h2>
      {incidents.length === 0 && <p className="text-sm text-stone-500">No incidents recorded.</p>}
      <div className="grid gap-2.5">
        {incidents.map((i, idx) => (
          <div key={idx} className="bg-stone-900 border border-stone-800 rounded-xl px-5 py-4">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-xs text-stone-500">{i.date}</span>
              <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wide border ${ST_BADGE[i.status] || ST_BADGE.resolved}`}>{i.status}</span>
            </div>
            <div className="font-bold text-white text-sm mt-1.5">{i.title}</div>
            {i.details && <div className="text-[13px] text-stone-400 mt-1">{i.details}</div>}
          </div>
        ))}
      </div>
      <p className="text-xs text-stone-600 mt-4">To log an incident, edit <span className="font-mono">client/src/data/incidents.json</span> and re-deploy.</p>
    </div>
  );
}
