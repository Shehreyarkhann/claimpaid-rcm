import { useEffect, useRef, useState } from 'react';
import { api, fmtMoney, fmtMoney2 } from '../api';
import { Modal, useToast } from './ui';

// Deadline audit (Phase 5, WS5) — the sales wedge as a product surface.
// The runner computes from the live workspace or from an uploaded CSV
// (through the import wizard's preview machinery — the CSV is audited,
// never imported). The report is the branded leave-behind: wordmark +
// stamp, the three horizon totals big, payer breakdown, the ranked
// expiring list, and the standing line. Print uses @media print rules
// in index.css that isolate .audit-report on the page.

export function AuditReportView({ result }) {
  if (!result) return null;
  const h = result.horizons || {};
  const tiles = [
    { key: 'd14', label: 'Expiring in 14 days', ...(h.d14 || { count: 0, amount: 0 }) },
    { key: 'd30', label: 'Expiring in 30 days', ...(h.d30 || { count: 0, amount: 0 }) },
    { key: 'd60', label: 'Expiring in 60 days', ...(h.d60 || { count: 0, amount: 0 }) },
  ];
  const generated = (() => {
    try { return new Date(result.generated_at).toLocaleString(); } catch { return result.generated_at; }
  })();
  return (
    <div className="audit-report bg-white">
      <div className="flex items-start gap-3 border-b-2 border-stone-900 pb-4">
        <img src="/app/claimpaid-icon.webp" alt="ClaimPaid" className="w-12 h-12" />
        <div className="min-w-0">
          <div className="font-display text-2xl font-bold tracking-tight text-stone-900">
            Claim<span className="text-emerald-600">Paid</span>
          </div>
          <div className="text-sm text-stone-500">Filing-deadline audit{result.workspace ? ` — ${result.workspace}` : ''}</div>
        </div>
        <img src="/app/claimpaid-icon.webp" alt="" aria-hidden="true"
          className="ml-auto w-16 h-16 opacity-90" style={{ transform: 'rotate(-12deg)' }} />
      </div>

      <p className="mt-4 font-display text-lg font-semibold text-stone-900">
        “We don't replace your system. We collect what it leaves behind.”
      </p>
      <p className="text-xs text-stone-400 mt-1">
        Generated {generated} · Source: {result.source === 'csv' ? `CSV file (${result.source_label || 'upload'}) — audited in place, nothing imported` : 'this workspace\u2019s live claims'}
        {result.skipped_rows ? ` · ${result.skipped_rows} rows skipped (missing claim number, date, or amount)` : ''}
      </p>

      <div className="grid grid-cols-3 gap-3 mt-5">
        {tiles.map((t) => (
          <div key={t.key} className="rounded-2xl bg-[#17251F] px-4 py-4 text-center">
            <div className="font-display text-3xl font-bold text-white">{fmtMoney(t.amount)}</div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-emerald-300 mt-1">{t.label}</div>
            <div className="text-xs text-stone-300 mt-0.5">{t.count} claim{t.count === 1 ? '' : 's'}</div>
          </div>
        ))}
      </div>
      {result.expired && result.expired.count > 0 && (
        <div className="mt-3 rounded-2xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-900">
          <b>{fmtMoney(result.expired.amount)}</b> across {result.expired.count} claim{result.expired.count === 1 ? ' is' : 's are'} already past the filing deadline —
          some payers still accept late appeals with proof of timely filing; the rest is the cost of the current process.
        </div>
      )}

      {(result.by_payer || []).length > 0 && (
        <div className="mt-6">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">By payer — expiring within 60 days</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500 border-b border-stone-200">
                <th className="py-2 pr-3">Payer</th><th className="py-2 pr-3">Claims</th>
                <th className="py-2 pr-3">Earliest deadline</th><th className="py-2 text-right">At risk</th>
              </tr>
            </thead>
            <tbody>
              {result.by_payer.map((p) => (
                <tr key={p.payer} className="border-b border-stone-100">
                  <td className="py-2 pr-3 font-medium text-stone-800">{p.payer}</td>
                  <td className="py-2 pr-3 text-stone-600">{p.count}</td>
                  <td className="py-2 pr-3 text-stone-600">{p.earliest_days < 0 ? `${-p.earliest_days}d past` : `${p.earliest_days}d left`}</td>
                  <td className="py-2 text-right font-medium text-stone-800">{fmtMoney2(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(result.top || []).length > 0 && (
        <div className="mt-6">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">The work list — top {result.top.length} expiring claims</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-stone-500 border-b border-stone-200">
                <th className="py-2 pr-2">#</th><th className="py-2 pr-3">Claim</th><th className="py-2 pr-3">Patient</th>
                <th className="py-2 pr-3">Payer</th><th className="py-2 pr-3">Deadline</th>
                <th className="py-2 pr-3">Days left</th><th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {result.top.map((c, i) => (
                <tr key={`${c.claim_number}-${i}`} className="border-b border-stone-100">
                  <td className="py-2 pr-2 text-stone-400">{i + 1}</td>
                  <td className="py-2 pr-3 font-medium text-stone-800">{c.claim_number}</td>
                  <td className="py-2 pr-3 text-stone-600">{c.patient || '—'}</td>
                  <td className="py-2 pr-3 text-stone-600">{c.payer}</td>
                  <td className="py-2 pr-3 text-stone-600">{c.deadline}</td>
                  <td className={`py-2 pr-3 font-medium ${c.days_left < 0 ? 'text-rose-700' : c.days_left <= 14 ? 'text-rose-700' : 'text-stone-700'}`}>
                    {c.days_left < 0 ? `${-c.days_left}d past` : `${c.days_left}d`}
                  </td>
                  <td className="py-2 text-right font-medium text-stone-800">{fmtMoney2(c.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-stone-400 mt-6 border-t border-stone-200 pt-3">
        Computed from {result.audited_claims} open claim{result.audited_claims === 1 ? '' : 's'} inside the 60-day window, using each payer's timely-filing
        limit (365 days where a payer has no rule on file). Balances are billed minus paid. ClaimPaid works this list daily —
        briefs, drafts, and follow-ups — with a person approving every save.
      </p>
    </div>
  );
}

export default function AuditRunner({ onClose }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [audit, setAudit] = useState(null);
  const [past, setPast] = useState([]);
  const csvRef = useRef(null);

  useEffect(() => {
    api.agent.audits().then((r) => setPast(r.audits || [])).catch(() => {});
  }, []);

  const runWorkspace = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.agent.runAudit({ source: 'workspace' });
      setAudit(r.audit);
    } catch (e) {
      setError(e.message || 'The audit could not be run');
    } finally { setBusy(false); }
  };

  const onCsv = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const p = await api.agent.importPreview(file);
      const r = await api.agent.runAudit({ source: 'csv', preview_id: p.preview.id });
      setAudit(r.audit);
      toast.success('Audit complete — nothing was imported');
    } catch (e) {
      setError(e.message || 'That CSV could not be audited');
    } finally {
      setBusy(false);
      if (csvRef.current) csvRef.current.value = '';
    }
  };

  const reopen = async (id) => {
    try {
      const r = await api.agent.audit(id);
      setAudit(r.audit);
    } catch (e) {
      toast.error(e.message || 'Could not reopen that audit');
    }
  };

  return (
    <Modal wide onClose={onClose}>
      <div className="p-6 sm:p-7">
        {!audit ? (
          <>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 flex items-center justify-center text-xl shrink-0">⏰</div>
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold text-stone-900">Run a deadline audit</h3>
                <p className="text-sm text-stone-500">How much money dies at a filing deadline in the next 14 / 30 / 60 days if nobody works it?</p>
              </div>
            </div>
            {error && <div className="mt-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
            <div className="grid sm:grid-cols-2 gap-3 mt-5">
              <div className="rounded-2xl border border-stone-200 bg-[#FFFDF8] p-5">
                <div className="font-semibold text-stone-900">This workspace</div>
                <p className="text-sm text-stone-500 mt-1">Compute from the live claims and payer filing rules already here.</p>
                <button className="btn btn-primary mt-4" disabled={busy} onClick={runWorkspace}>{busy ? 'Computing…' : 'Audit this workspace'}</button>
              </div>
              <div className="rounded-2xl border border-stone-200 bg-[#FFFDF8] p-5">
                <div className="font-semibold text-stone-900">A CSV export</div>
                <p className="text-sm text-stone-500 mt-1">Audit a spreadsheet from any system. The file is analyzed in place — <b>nothing is imported</b>.</p>
                <label className={`btn btn-dark mt-4 ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
                  {busy ? 'Auditing…' : 'Upload a CSV'}
                  <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onCsv(e.target.files && e.target.files[0])} />
                </label>
              </div>
            </div>
            {past.length > 0 && (
              <div className="mt-5">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Previous audits</div>
                <div className="space-y-1.5">
                  {past.map((a) => (
                    <button key={a.id} onClick={() => reopen(a.id)}
                      className="w-full text-left rounded-xl px-4 py-2.5 bg-white ring-1 ring-stone-200 hover:ring-stone-300 transition flex items-center gap-3">
                      <span className="text-sm font-medium text-stone-800">{a.source === 'csv' ? `CSV — ${a.source_label || 'file'}` : 'Workspace'}</span>
                      {a.horizons && <span className="text-xs text-stone-500">60d: {fmtMoney(a.horizons.d60.amount)} · {a.horizons.d60.count} claims</span>}
                      <span className="ml-auto text-[11px] text-stone-400">{new Date(String(a.created_at).replace(' ', 'T') + 'Z').toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex mt-5 pt-4 border-t border-stone-100">
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <AuditReportView result={audit.result} />
            <div className="no-print flex items-center gap-2 mt-6 pt-4 border-t border-stone-100">
              <button className="btn btn-ghost" onClick={() => setAudit(null)}>← Run another</button>
              <div className="ml-auto flex gap-2">
                <button className="btn btn-outline" onClick={onClose}>Close</button>
                <button className="btn btn-primary" onClick={() => window.print()}>🖨 Print / save PDF</button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
