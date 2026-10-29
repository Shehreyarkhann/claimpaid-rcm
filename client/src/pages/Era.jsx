import { useEffect, useRef, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney, fmtDate } from '../api';
import { PageHeader, EmptyState, Modal, Skeleton, useToast } from '../components/ui';
import ClaimDetailsModal from '../components/ClaimDetailsModal';

const FLAG_LABELS = {
  unmatched: ['No matching claim', 'badge-rose'],
  variance: ['Balance variance', 'badge-amber'],
  denial: ['Denial', 'badge-rose'],
  reversal: ['Reversal', 'badge-violet'],
  duplicate: ['Possible duplicate', 'badge-amber'],
  claim_closed: ['Claim already paid', 'badge-amber'],
  zero_pay: ['$0 payment', 'badge-slate'],
  suggested_match: ['Suggested match found', 'badge-blue'],
};

const ERA_STATUS = {
  received: ['Needs review', 'badge-amber'],
  partially_posted: ['Partially posted', 'badge-blue'],
  posted: ['Fully posted', 'badge-green'],
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function MatchModal({ line, onClose, onDone }) {
  const toast = useToast();
  const [q, setQ] = useState(line.suggested_claim_number || line.clp_ref || '');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);

  const search = (term) => {
    api.era.matchCandidates(term)
      .then((d) => setRows(d.claims))
      .catch((e) => toast.error(e.message));
  };
  useEffect(() => { search(q); }, []);

  const choose = async (claimId, post) => {
    setBusy(true);
    try {
      await api.era.matchLine(line.id, claimId, post);
      toast.success(post ? 'Matched and posted' : 'Matched — ready to post');
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Match ERA line to a claim</h3>
        <p className="text-sm text-stone-500 mb-4">
          ERA reference <strong>{line.clp_ref}</strong>
          {line.patient_name && <> · patient {line.patient_name}</>} · billed {fmtMoney(line.billed)} · paid {fmtMoney(line.paid)}
          {line.suggested_claim_id && <> · suggested: <strong>{line.suggested_claim_number}</strong></>}
        </p>
        <div className="flex gap-2 mb-4">
          <input className="input flex-1" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by claim number or patient name" />
          <button className="btn btn-outline" onClick={() => search(q)}>Search</button>
        </div>
        {!rows && <Skeleton className="h-24" />}
        {rows && rows.length === 0 && <p className="text-sm text-stone-500">No claims match that search.</p>}
        <div className="space-y-2 max-h-80 overflow-auto">
          {(rows || []).map((c) => (
            <div key={c.id} className="flex items-center gap-3 border border-stone-200 rounded-xl px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-stone-900">{c.claim_number}
                  {line.suggested_claim_id === c.id && <span className="badge badge-blue ml-2">Suggested</span>}
                </div>
                <div className="text-xs text-stone-500">{c.patient_name} · DOS {fmtDate(c.service_date)} · billed {fmtMoney(c.billed_amount)} · paid {fmtMoney(c.paid_amount)} · {c.status}</div>
              </div>
              <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => choose(c.id, false)}>Match</button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => choose(c.id, true)}>Match &amp; post</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function LineRow({ line, canWrite, onChanged, onMatch, onShowDetails }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); toast.success(msg); onChanged(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const adjSummary = (line.adjustments || []).slice(0, 3)
    .map((a) => `${a.group}-${a.code} ${fmtMoney(a.amount)}`).join(' · ');
  return (
    <tr className="border-t border-stone-100 align-top">
      <td className="py-2 pr-3">
        <div className="font-medium text-stone-900">{line.clp_ref}</div>
        <div className="text-xs text-stone-500">{line.patient_name || '—'}{line.payer_icn && <> · ICN {line.payer_icn}</>}</div>
        {adjSummary && <div className="text-xs text-stone-400 mt-0.5">{adjSummary}</div>}
        {line.denial_reason && <div className="text-xs text-rose-600 mt-0.5">{line.denial_reason}</div>}
      </td>
      <td className="py-2 pr-3 text-sm">
        {line.matched_claim_number
          ? <span className="font-medium text-stone-800">{line.matched_claim_number}</span>
          : <span className="text-stone-400">—</span>}
        {line.match_method && <div className="text-xs text-stone-400">via {line.match_method.replace('_', ' ')}</div>}
        {line.match_claim_id && onShowDetails && (
          <button className="text-[11px] font-semibold text-emerald-700 hover:underline"
            onClick={() => onShowDetails(line.match_claim_id)}>
            Claim details
          </button>
        )}
      </td>
      <td className="py-2 pr-3 text-right text-sm">{fmtMoney(line.billed)}</td>
      <td className="py-2 pr-3 text-right text-sm">{fmtMoney(line.paid)}</td>
      <td className="py-2 pr-3 text-right text-sm">{fmtMoney(line.total_adjustments)}</td>
      <td className="py-2 pr-3 text-right text-sm">{fmtMoney(line.patient_resp)}</td>
      <td className="py-2 pr-3 text-right text-sm">
        {Math.abs(line.variance) > 0.02
          ? <span className="text-amber-700 font-medium">{fmtMoney(line.variance)}</span>
          : <span className="text-stone-400">—</span>}
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap gap-1">
          {(line.flags || []).map((f) => {
            const [label, cls] = FLAG_LABELS[f] || [f, 'badge-slate'];
            return <span key={f} className={`badge ${cls}`}>{label}</span>;
          })}
          {line.post_status === 'posted' && <span className="badge badge-green">Posted</span>}
          {line.post_status === 'ignored' && <span className="badge badge-slate">Ignored</span>}
          {line.post_status === 'pending' && <span className="badge badge-amber">Exception</span>}
        </div>
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {canWrite && line.post_status === 'pending' && (
          <div className="flex gap-1 justify-end">
            {line.match_claim_id && (
              <button className="btn btn-primary btn-sm" disabled={busy}
                onClick={() => act(() => api.era.postLine(line.id), 'Payment posted')}>Post</button>
            )}
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => onMatch(line)}>
              {line.match_claim_id ? 'Re-match' : 'Match'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => act(() => api.era.ignoreLine(line.id), 'Line ignored')}>Ignore</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function RemittanceCard({ era, canWrite, onChanged, onMatch, onShowDetails }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [label, cls] = ERA_STATUS[era.status] || ERA_STATUS.received;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      api.era.remittance(era.id).then(setDetail).catch(() => {});
    }
  };
  const refresh = () => {
    setDetail(null);
    api.era.remittance(era.id).then(setDetail).catch(() => {});
    onChanged();
  };

  return (
    <div className="card mb-4 overflow-hidden">
      <button className="w-full text-left px-5 py-4 flex flex-wrap items-center gap-3 hover:bg-stone-50" onClick={toggle}>
        <div className="flex-1 min-w-48">
          <div className="font-semibold text-stone-900">{era.payer_name || 'Unknown payer'}</div>
          <div className="text-xs text-stone-500">
            {era.source_filename} · uploaded {fmtDate(era.created_at)}
            {era.check_number && <> · Check/EFT {era.check_number}</>}
            {era.pay_date && <> · paid {fmtDate(era.pay_date)}</>}
          </div>
        </div>
        <div className="text-sm text-stone-600">
          {era.line_count} lines · <strong>{fmtMoney(era.total_paid)}</strong> paid · {era.posted_count} posted
          {era.pending_count > 0 && <> · <span className="text-amber-700 font-medium">{era.pending_count} exceptions</span></>}
        </div>
        <span className={`badge ${cls}`}>{label}</span>
        <span className="text-stone-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 overflow-x-auto">
          {!detail && <Skeleton className="h-32" />}
          {detail && (
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-stone-400">
                  <th className="py-2 pr-3">ERA reference</th><th className="py-2 pr-3">Claim</th>
                  <th className="py-2 pr-3 text-right">Billed</th><th className="py-2 pr-3 text-right">Paid</th>
                  <th className="py-2 pr-3 text-right">Adjustments</th><th className="py-2 pr-3 text-right">Patient resp.</th>
                  <th className="py-2 pr-3 text-right">Variance</th><th className="py-2 pr-3">Flags</th><th />
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <LineRow key={l.id} line={l} canWrite={canWrite} onChanged={refresh} onMatch={onMatch} onShowDetails={onShowDetails} />
                ))}
              </tbody>
            </table>
          )}
          {era.plb_total !== 0 && detail && (
            <p className="text-xs text-stone-500 mt-3">
              Provider-level adjustments (PLB) on this remittance: {fmtMoney(era.plb_total)} — these are payer-level
              offsets (e.g. withholds, interest, prior overpayment recovery) and are tracked for reconciliation, not posted to claims.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Era() {
  const { user } = useAuth();
  const toast = useToast();
  const canWrite = ['owner', 'biller'].includes(user?.role);
  const fileRef = useRef(null);
  const [remittances, setRemittances] = useState(null);
  const [recon, setRecon] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [matchLine, setMatchLine] = useState(null);
  const [detailsClaimId, setDetailsClaimId] = useState(null);

  const load = () => {
    api.era.remittances().then((d) => setRemittances(d.remittances)).catch((e) => toast.error(e.message));
    api.era.reconciliation().then(setRecon).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true); setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await authFetch('/api/era/upload-835', { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setResult(body);
      toast.success(`835 processed: ${body.autoPosted} auto-posted, ${body.exceptions} exceptions`);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const downloadCsv = async () => {
    try {
      const res = await authFetch('/api/era/reconciliation.csv');
      if (!res.ok) throw new Error('Export failed');
      downloadBlob(await res.blob(), 'era-reconciliation.csv');
    } catch (e) { toast.error(e.message); }
  };

  const t = recon?.totals;

  return (
    <div>
      <PageHeader
        title="ERA Auto-Posting"
        subtitle="Upload an 835 remittance — clean payments post themselves, exceptions wait here for one click."
        actions={canWrite ? [
          <button key="up" className="btn btn-primary" disabled={uploading} onClick={() => fileRef.current.click()}>
            {uploading ? 'Processing…' : '⬆ Upload 835 ERA'}
          </button>,
          <button key="csv" className="btn btn-outline" onClick={downloadCsv}>Reconciliation CSV</button>,
        ] : [
          <button key="csv" className="btn btn-outline" onClick={downloadCsv}>Reconciliation CSV</button>,
        ]}
      />
      <input ref={fileRef} type="file" accept=".835,.txt,.dat" className="hidden" onChange={handleUpload} />

      {result && (
        <div className="card p-5 mb-5 !border-emerald-200 bg-emerald-50/50">
          <div className="font-semibold text-stone-900 mb-1">835 processed — {result.file}</div>
          <div className="text-sm text-stone-600">
            {result.payer && <>Payer: <strong>{result.payer}</strong> · </>}
            {result.checkNumber && <>Check/EFT: <strong>{result.checkNumber}</strong> · </>}
            {result.payDate && <>Date: <strong>{result.payDate}</strong></>}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {[['Auto-posted', result.autoPosted, 'text-emerald-700'],
              ['Paid in full', result.paid, 'text-emerald-700'],
              ['Denied', result.denied, 'text-rose-700'],
              ['Exceptions to review', result.exceptions, 'text-amber-700']].map(([l, v, c]) => (
              <div key={l} className="bg-white rounded-xl border border-stone-200 p-3 text-center">
                <div className={`text-2xl font-bold ${c}`}>{v}</div>
                <div className="text-xs text-stone-500">{l}</div>
              </div>
            ))}
          </div>
          {result.exceptions > 0 && (
            <p className="text-sm text-stone-600 mt-3">
              Exceptions are below in the remittance — unmatched claims, balance variances, reversals and
              already-paid claims are never auto-posted. Resolve each with Post, Match or Ignore.
            </p>
          )}
        </div>
      )}

      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          {[
            ['ERA paid (all lines)', fmtMoney(t.paid)],
            ['Adjustments', fmtMoney(t.adjustments)],
            ['Patient responsibility', fmtMoney(t.patient_resp)],
            ['Open exceptions', String(t.pending_lines || 0)],
            ['Open claim balance', fmtMoney(recon.openClaimBalance)],
          ].map(([l, v]) => (
            <div key={l} className="card p-4">
              <div className="text-xl font-bold text-stone-900">{v}</div>
              <div className="text-xs text-stone-500 mt-0.5">{l}</div>
            </div>
          ))}
        </div>
      )}

      {recon && recon.byPayer.length > 0 && (
        <div className="card p-5 mb-6 overflow-x-auto">
          <h3 className="font-semibold text-stone-900 mb-3">Reconciliation by payer</h3>
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-400">
                <th className="py-2 pr-3">Payer</th><th className="py-2 pr-3 text-right">ERAs</th>
                <th className="py-2 pr-3 text-right">Billed</th><th className="py-2 pr-3 text-right">Paid</th>
                <th className="py-2 pr-3 text-right">Adjustments</th><th className="py-2 pr-3 text-right">Patient resp.</th>
                <th className="py-2 text-right">Pending</th>
              </tr>
            </thead>
            <tbody>
              {recon.byPayer.map((p) => (
                <tr key={p.payer} className="border-t border-stone-100">
                  <td className="py-2 pr-3 font-medium text-stone-800">{p.payer}</td>
                  <td className="py-2 pr-3 text-right">{p.remittances}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(p.billed)}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(p.paid)}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(p.adjustments)}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(p.patient_resp)}</td>
                  <td className="py-2 text-right">{p.pending_lines || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!remittances && <Skeleton className="h-40" />}
      {remittances && remittances.length === 0 && (
        <EmptyState
          icon="🧾"
          title="No remittances yet"
          hint="Upload your first 835 ERA file and ClaimPaid will match every claim line, post the clean payments automatically, and queue only the exceptions for you."
        />
      )}
      {(remittances || []).map((era) => (
        <RemittanceCard key={era.id} era={era} canWrite={canWrite} onChanged={load} onMatch={setMatchLine} onShowDetails={setDetailsClaimId} />
      ))}

      {matchLine && (
        <MatchModal line={matchLine} onClose={() => setMatchLine(null)}
          onDone={() => { setMatchLine(null); load(); }} />
      )}
      {detailsClaimId && (
        <ClaimDetailsModal claimId={detailsClaimId} onClose={() => setDetailsClaimId(null)} />
      )}
    </div>
  );
}
