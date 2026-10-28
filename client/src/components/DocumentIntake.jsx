import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtMoney2 } from '../api';
import { useToast } from './ui';

// Document intake (Phase 5, WS1) — paper EOBs and denial letters.
// Upload extracts + validates server-side; this screen is the human
// review: problems are listed verbatim, matched lines are highlighted,
// unmatched lines get a claim picker (with the server's suggestion
// marked). Applying NEVER happens here directly — "Propose apply"
// creates the standard pending approval card (rendered by the Agent
// page's ActionCard, passed in as a prop to avoid an import cycle), and
// only an approval creates the held ERA remittance / attaches the
// denial. Rejecting the card dismisses the document.

const KIND_LABEL = { remittance: 'Remittance / EOB', denial_letter: 'Denial letter', unknown: 'Unclassified' };
const STATUS_META = {
  extracted: { pill: 'badge-green', label: 'Ready to apply' },
  needs_review: { pill: 'badge-amber', label: 'Needs review' },
  extract_failed: { pill: 'badge-rose', label: 'Extraction failed' },
  applied: { pill: 'badge-green', label: 'Applied' },
  dismissed: { pill: 'badge-slate', label: 'Dismissed' },
};

export default function DocumentIntake({ ActionCard }) {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [claims, setClaims] = useState([]);
  const [decidingId, setDecidingId] = useState(null);
  const [proposing, setProposing] = useState(false);
  const fileRef = useRef(null);

  const loadDocs = useCallback(async () => {
    try {
      const r = await api.agent.documents();
      setDocs(r.documents || []);
    } catch { /* section shows its empty state */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  useEffect(() => {
    api.claims({ limit: 100 }).then((d) => setClaims(d.claims || [])).catch(() => {});
  }, []);

  const openDoc = async (id) => {
    try {
      const r = await api.agent.document(id);
      setDetail(r.document);
    } catch (e) {
      toast.error(e.message || 'Could not open that document');
    }
  };

  const refreshDetail = async (id) => {
    try {
      const r = await api.agent.document(id);
      setDetail(r.document);
    } catch { /* keep current */ }
    loadDocs();
  };

  const onUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const r = await api.agent.uploadDocument(file);
      toast.success(r.document.status === 'extract_failed'
        ? 'Uploaded — extraction failed, the document is saved for review'
        : 'Document extracted — review it below');
      await loadDocs();
      setDetail(r.document);
    } catch (e) {
      toast.error(e.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onMatch = async (data) => {
    if (!detail) return;
    try {
      const r = await api.agent.matchDocument(detail.id, data);
      setDetail(r.document);
      loadDocs();
    } catch (e) {
      toast.error(e.message || 'Could not update the match');
    }
  };

  const propose = async () => {
    if (!detail) return;
    setProposing(true);
    try {
      await api.agent.proposeApplyDocument(detail.id);
      toast.success('Apply proposal created — decide on the card below');
      await refreshDetail(detail.id);
    } catch (e) {
      toast.error(e.message || 'Could not propose the apply');
    } finally {
      setProposing(false);
    }
  };

  const decide = async (action, decision) => {
    setDecidingId(action.id);
    try {
      const r = decision === 'approve' ? await api.agent.approveAction(action.id) : await api.agent.rejectAction(action.id);
      if (decision === 'approve' && r.action.status === 'executed') toast.success('Approved and applied');
      if (decision === 'approve' && r.action.status === 'failed') toast.error('Approval recorded, but applying failed');
      if (decision === 'reject') toast.success('Rejected — the document is dismissed, nothing was created');
      if (detail) await refreshDetail(detail.id);
    } catch (e) {
      toast.error(e.message || 'Could not record that decision');
    } finally {
      setDecidingId(null);
    }
  };

  const dismiss = async () => {
    if (!detail) return;
    try {
      const r = await api.agent.dismissDocument(detail.id);
      setDetail(r.document);
      loadDocs();
      toast.success('Document dismissed — nothing was created');
    } catch (e) {
      toast.error(e.message || 'Dismiss failed');
    }
  };

  const viewFile = async () => {
    if (!detail) return;
    try {
      const res = await api.agent.documentFile(detail.id);
      if (!res.ok) throw new Error('The stored file could not be loaded');
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      toast.error(e.message || 'Could not open the file');
    }
  };

  const claimOptions = claims.map((c) => ({ id: c.id, label: `${c.claim_number} — ${c.patient_name} — ${fmtMoney2(c.billed_amount)}` }));

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="font-display font-semibold text-stone-900 text-lg">Document intake</div>
        <div className="text-xs text-stone-400">Paper EOBs and denial letters — extracted, checked, and applied only with your approval</div>
      </div>

      <label
        className={`mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-stone-300 bg-[#FAF5EB]/60 px-4 py-6 text-center cursor-pointer transition hover:border-emerald-400 ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onUpload(e.dataTransfer.files && e.dataTransfer.files[0]); }}
      >
        <span className="text-2xl mb-1">📄</span>
        <span className="text-sm font-medium text-stone-700">{uploading ? 'Extracting…' : 'Drop a remittance / EOB or denial letter here, or click to choose'}</span>
        <span className="text-xs text-stone-400 mt-0.5">PDF, PNG, or JPG · up to 10 MB · the agent reads it — a person approves before anything is created</span>
        <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className="hidden"
          onChange={(e) => onUpload(e.target.files && e.target.files[0])} />
      </label>

      <div className="mt-4 space-y-2">
        {loading && <p className="text-sm text-stone-400">Loading documents…</p>}
        {!loading && docs.length === 0 && (
          <p className="text-sm text-stone-400">No documents yet — the first EOB you drop in starts the intake queue.</p>
        )}
        {docs.map((d) => {
          const meta = STATUS_META[d.status] || STATUS_META.needs_review;
          return (
            <button key={d.id} onClick={() => openDoc(d.id)}
              className={`w-full text-left rounded-xl px-4 py-3 ring-1 transition ${detail && detail.id === d.id ? 'bg-emerald-50 ring-emerald-200' : 'bg-white ring-stone-200 hover:ring-stone-300'}`}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm text-stone-800 truncate max-w-[260px]">{d.filename}</span>
                <span className="badge badge-slate">{KIND_LABEL[d.kind] || d.kind}</span>
                <span className={`badge ${meta.pill}`}>{meta.label}</span>
                {d.kind === 'remittance' && <span className="text-xs text-stone-500">{d.matched_count}/{d.line_count} lines matched</span>}
                {d.kind === 'denial_letter' && <span className="text-xs text-stone-500">{d.claim_number || ''} {d.matched ? '· matched' : '· not matched'}</span>}
                <span className="ml-auto text-[11px] text-stone-400">{new Date(String(d.created_at).replace(' ', 'T') + 'Z').toLocaleString()}</span>
              </span>
            </button>
          );
        })}
      </div>

      {detail && (
        <DocumentReview
          doc={detail}
          claimOptions={claimOptions}
          ActionCard={ActionCard}
          decidingId={decidingId}
          proposing={proposing}
          onMatch={onMatch}
          onPropose={propose}
          onDecide={decide}
          onDismiss={dismiss}
          onViewFile={viewFile}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function DocumentReview({ doc, claimOptions, ActionCard, decidingId, proposing, onMatch, onPropose, onDecide, onDismiss, onViewFile, onClose }) {
  const ex = doc.extracted;
  const closed = doc.status === 'applied' || doc.status === 'dismissed';
  const claimSelect = (value, onPick, suggestedId) => (
    <select className="input !py-1.5 !text-xs max-w-[240px]" value={value || ''}
      onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Not matched — pick a claim…</option>
      {claimOptions.map((c) => (
        <option key={c.id} value={c.id}>{c.label}{suggestedId === c.id ? ' (suggested)' : ''}</option>
      ))}
    </select>
  );

  return (
    <div className="mt-4 rounded-2xl border border-stone-200 bg-[#FFFDF8] p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="font-semibold text-stone-900 text-sm">{doc.filename}</span>
        <span className="badge badge-slate">{KIND_LABEL[doc.kind] || doc.kind}</span>
        <span className={`badge ${(STATUS_META[doc.status] || {}).pill || 'badge-slate'}`}>{(STATUS_META[doc.status] || {}).label || doc.status}</span>
        <span className="ml-auto flex gap-2">
          <button className="btn btn-outline btn-sm" onClick={onViewFile}>View document</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </span>
      </div>

      {doc.problems && doc.problems.length > 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 mb-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 mb-1">Check before applying</div>
          <ul className="list-disc pl-5 space-y-0.5 text-[13px] text-amber-900">
            {doc.problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {doc.kind === 'remittance' && ex && (
        <div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm mb-3">
            <span><span className="text-stone-400">Payer</span> <b className="text-stone-800">{ex.payer || '— not stated'}</b></span>
            <span><span className="text-stone-400">Check / EFT</span> <b className="text-stone-800">{ex.check_number || '—'}</b></span>
            <span><span className="text-stone-400">Paid date</span> <b className="text-stone-800">{ex.pay_date || '—'}</b></span>
            <span><span className="text-stone-400">Check total</span> <b className="text-stone-800">{ex.payment_amount != null ? fmtMoney2(ex.payment_amount) : '— not stated'}</b></span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2">Claim</th><th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2 text-right">Billed</th><th className="px-3 py-2 text-right">Paid</th>
                  <th className="px-3 py-2">Adjustments</th><th className="px-3 py-2 text-right">Pt resp</th>
                  <th className="px-3 py-2">Match</th>
                </tr>
              </thead>
              <tbody>
                {(ex.lines || []).map((l, i) => (
                  <tr key={i} className={`border-t border-stone-100 ${l.matched_claim_id ? 'bg-emerald-50/50' : 'bg-amber-50/40'}`}>
                    <td className="px-3 py-2 font-medium text-stone-800">{l.claim_number || <span className="text-rose-600">not readable</span>}</td>
                    <td className="px-3 py-2 text-stone-600">{l.patient || '—'}</td>
                    <td className="px-3 py-2 text-right">{l.billed != null ? fmtMoney2(l.billed) : '—'}</td>
                    <td className="px-3 py-2 text-right">{l.paid != null ? fmtMoney2(l.paid) : '—'}</td>
                    <td className="px-3 py-2 text-stone-600">{(l.adjustments || []).map((a) => `${a.group} ${a.code || a.text} ${fmtMoney2(a.amount)}`).join(' · ') || '—'}</td>
                    <td className="px-3 py-2 text-right">{l.patient_resp != null ? fmtMoney2(l.patient_resp) : '—'}</td>
                    <td className="px-3 py-2">
                      {closed ? (
                        <span className={l.matched_claim_id ? 'text-emerald-700 font-medium' : 'text-stone-400'}>{l.matched_claim_id ? 'Matched' : 'Unmatched'}</span>
                      ) : l.matched_claim_id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="badge badge-green">Matched</span>
                          <button className="text-xs text-stone-400 underline" onClick={() => onMatch({ line_index: i, claim_id: null })}>clear</button>
                        </span>
                      ) : (
                        claimSelect(null, (id) => onMatch({ line_index: i, claim_id: id }), l.suggested_claim_id)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {doc.kind === 'denial_letter' && ex && (
        <div className="space-y-2 text-sm">
          <div className="flex items-baseline gap-2"><span className="text-stone-500 w-32 shrink-0">Payer</span><span className="font-medium text-stone-800">{ex.payer || '— not stated'}</span></div>
          <div className="flex items-baseline gap-2"><span className="text-stone-500 w-32 shrink-0">Patient</span><span className="font-medium text-stone-800">{ex.patient || '—'}</span></div>
          <div className="flex items-baseline gap-2"><span className="text-stone-500 w-32 shrink-0">Denial</span><span className="font-medium text-stone-800">{(ex.denial_reasons || []).join('; ') || '— none read'}</span></div>
          <div className="flex items-baseline gap-2"><span className="text-stone-500 w-32 shrink-0">Appeal deadline</span><span className="font-medium text-stone-800">{ex.appeal_deadline || '— not stated on the letter'}</span></div>
          {ex.appeal_address && <div className="flex items-baseline gap-2"><span className="text-stone-500 w-32 shrink-0">Appeals address</span><span className="font-medium text-stone-800">{ex.appeal_address}</span></div>}
          <div className="flex items-center gap-2">
            <span className="text-stone-500 w-32 shrink-0">Claim</span>
            {closed
              ? <span className="font-medium text-stone-800">{ex.claim_id ? 'Matched' : 'Not matched'}</span>
              : claimSelect(ex.claim_id, (id) => onMatch({ claim_id: id }), ex.suggested_claim_id)}
          </div>
        </div>
      )}

      {doc.kind === 'unknown' && (
        <p className="text-sm text-stone-500">This document couldn't be classified as a remittance/EOB or a denial letter, so there is nothing to apply. You can view it or dismiss it.</p>
      )}

      {doc.status === 'applied' && (
        <p className="text-sm text-emerald-700 font-medium mt-3">
          {doc.kind === 'remittance'
            ? `Applied — the remittance is in the ERA inbox${doc.era_id ? ` (#${doc.era_id})` : ''}, HELD with every line unposted. Post lines from the ERA tab.`
            : 'Applied — the denial is recorded on the claim, and any appeal draft is waiting as its own card.'}
        </p>
      )}
      {doc.status === 'dismissed' && <p className="text-sm text-stone-500 mt-3">Dismissed — nothing was created from this document.</p>}

      {!closed && doc.kind !== 'unknown' && !doc.action && (
        <div className="flex gap-2 mt-4">
          <button className="btn btn-primary btn-sm" disabled={proposing} onClick={onPropose}>
            {proposing ? 'Preparing…' : 'Propose apply'}
          </button>
          <button className="btn btn-outline btn-sm" onClick={onDismiss}>Dismiss document</button>
        </div>
      )}
      {!closed && doc.kind === 'unknown' && !doc.action && (
        <div className="flex gap-2 mt-4">
          <button className="btn btn-outline btn-sm" onClick={onDismiss}>Dismiss document</button>
        </div>
      )}
      {doc.action && ActionCard && (
        <div className="mt-4">
          <ActionCard action={doc.action} busy={decidingId === doc.action.id} onDecide={onDecide} />
        </div>
      )}
    </div>
  );
}
