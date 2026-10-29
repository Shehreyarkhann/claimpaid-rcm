import { useEffect, useState } from 'react';
import { api, fmtMoney2, fmtDate } from '../api';
import { Modal, Skeleton } from './ui';

// Claim details (deploy #98) — ONE shared read surface for a claim, used by
// Denials, the Agent tab, My Work, ERA and Claims. Before this, a denied
// claim's patient/DOB/member ID/codes/money existed only inside the text
// of a drafted appeal letter; every surface that referenced a claim now
// opens the full record here instead. Read-only: editing stays in the
// Claims edit form (reachable via the Edit button when the host passes
// onEditClaim), appeals open in Denial Appeals (onOpenAppeal).

const STATUS_META = {
  paid: { label: 'Paid', badge: 'badge-green' },
  pending: { label: 'Pending', badge: 'badge-blue' },
  in_ar: { label: 'In A/R', badge: 'badge-amber' },
  denied: { label: 'Denied', badge: 'badge-rose' },
};

const APPEAL_STATUS = {
  open: ['Open', 'badge-slate'],
  in_progress: ['In Progress', 'badge-blue'],
  submitted: ['Submitted', 'badge-amber'],
  won: ['Won', 'badge-green'],
  lost: ['Lost', 'badge-rose'],
};

const SUBMIT_VIA_LABEL = {
  payer_portal: 'payer portal', fax: 'fax', mail: 'mail', clearinghouse: 'clearinghouse',
};

function FilingTreatment({ days }) {
  if (days == null) return <span className="text-stone-400">—</span>;
  if (days < 0) return <span className="badge badge-rose">Expired {-days}d ago</span>;
  if (days <= 14) return <span className="badge badge-rose">{days}d left</span>;
  if (days <= 30) return <span className="badge badge-amber">{days}d left</span>;
  return <span className="text-stone-600">{days} days left</span>;
}

function splitCodes(s) {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseAdjustments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}

function Fact({ label, children }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-stone-500 w-36 shrink-0">{label}</span>
      <span className="font-medium text-stone-800 min-w-0">{children}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">{children}</div>;
}

export default function ClaimDetailsModal({ claimId, onClose, onEditClaim, onOpenAppeal }) {
  const [claim, setClaim] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setClaim(null); setError('');
    api.claimDetail(claimId)
      .then((d) => { if (live) setClaim(d); })
      .catch((e) => { if (live) setError(e.message || 'That claim could not be loaded'); });
    return () => { live = false; };
  }, [claimId]);

  if (error) {
    return (
      <Modal onClose={onClose} wide>
        <div className="p-7">
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>
          <div className="flex justify-end mt-5"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
        </div>
      </Modal>
    );
  }
  if (!claim) {
    return <Modal onClose={onClose} wide><div className="p-7"><Skeleton className="h-72" /></div></Modal>;
  }

  const sm = STATUS_META[claim.status] || STATUS_META.pending;
  const cpts = splitCodes(claim.cpt_codes);
  const icds = splitCodes(claim.icd_codes);
  const eraLines = claim.era_lines || [];
  const allAdjustments = eraLines.flatMap((l) => parseAdjustments(l.adjustments));
  const appeals = claim.appeals || [];

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="text-xs font-mono text-stone-400">{claim.claim_number}</div>
            <h3 className="text-xl font-bold tracking-tight">{claim.patient_name}</h3>
            <div className="text-sm text-stone-500 mt-0.5">
              {claim.payer} · DOS {fmtDate(claim.service_date)} · {claim.days_in_ar ?? 0} days in A/R
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`badge ${sm.badge}`}>{sm.label}</span>
            <button onClick={onClose} className="btn-ghost btn !px-2.5">✕</button>
          </div>
        </div>

        {/* Money rollups — the claim's own ERA posting totals */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5 mt-5">
          {[
            ['Billed', claim.billed_amount],
            ['Allowed', claim.allowed_amount],
            ['Paid', claim.paid_amount],
            ['Adjustments', claim.adjustment_amount],
            ['Patient resp.', claim.patient_resp_amount],
            ['Patient paid', claim.patient_paid_amount],
          ].map(([label, v]) => (
            <div key={label} className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3 py-2">
              <div className="font-display text-[15px] font-semibold text-stone-900">{v == null ? '—' : fmtMoney2(v)}</div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-stone-500">{label}</div>
            </div>
          ))}
        </div>

        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5 mt-6">
          <div>
            <SectionTitle>Patient</SectionTitle>
            <div className="space-y-1.5">
              <Fact label="Name">{claim.patient_name}</Fact>
              <Fact label="Date of birth">{claim.patient_dob ? fmtDate(claim.patient_dob) : '—'}</Fact>
              <Fact label="Member / subscriber ID">{claim.member_id || '—'}</Fact>
            </div>
          </div>
          <div>
            <SectionTitle>Claim</SectionTitle>
            <div className="space-y-1.5">
              <Fact label="Payer">{claim.payer}{claim.payer_type ? ` (${claim.payer_type})` : ''}</Fact>
              <Fact label="Date of service">{fmtDate(claim.service_date)}</Fact>
              <Fact label="Rendering provider">{claim.rendering_provider || '—'}{claim.rendering_npi ? ` · NPI ${claim.rendering_npi}` : ''}</Fact>
              {claim.payer_icn && <Fact label="Payer ICN">{claim.payer_icn}</Fact>}
              <Fact label="Filing deadline">
                {claim.filing_deadline ? <>{fmtDate(claim.filing_deadline)} · <FilingTreatment days={claim.days_until_filing} /></> : '—'}
              </Fact>
            </div>
          </div>
        </div>

        {(cpts.length > 0 || icds.length > 0) && (
          <div className="mt-6">
            <SectionTitle>Services & diagnoses</SectionTitle>
            {cpts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="text-xs text-stone-500 w-16 shrink-0">CPT</span>
                {cpts.map((c) => <span key={c} className="badge badge-slate font-mono">{c}</span>)}
              </div>
            )}
            {icds.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-stone-500 w-16 shrink-0">ICD-10</span>
                {icds.map((c) => <span key={c} className="badge badge-slate font-mono">{c}</span>)}
              </div>
            )}
          </div>
        )}

        {(claim.denial_reason || allAdjustments.length > 0) && (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50/50 px-4 py-3.5">
            <SectionTitle>Denial</SectionTitle>
            {claim.denial_reason && <div className="text-sm text-stone-800 font-medium">{claim.denial_reason}</div>}
            {allAdjustments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {allAdjustments.map((a, i) => (
                  <span key={i} className="badge badge-rose font-mono" title={a.text || undefined}>
                    {a.group}-{a.code} · {fmtMoney2(a.amount)}
                  </span>
                ))}
              </div>
            )}
            <div className="text-[11px] text-stone-400 mt-2">Adjustment codes are from the matched ERA lines (CAS group–reason).</div>
          </div>
        )}

        {appeals.length > 0 && (
          <div className="mt-6">
            <SectionTitle>Appeals ({appeals.length})</SectionTitle>
            <div className="space-y-2">
              {appeals.map((a) => {
                const [label, badge] = APPEAL_STATUS[a.status] || APPEAL_STATUS.open;
                return (
                  <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-stone-50 ring-1 ring-stone-200/70 px-4 py-3 text-sm">
                    <span className={`badge ${badge}`}>{label}</span>
                    <span className="text-stone-600 capitalize">{a.priority} priority</span>
                    {a.has_letter && a.status === 'open' && <span className="badge badge-amber">📝 Drafted — not submitted</span>}
                    {a.status === 'submitted' && a.submitted_via && (
                      <span className="text-xs text-stone-500">via {SUBMIT_VIA_LABEL[a.submitted_via] || a.submitted_via}{a.submitted_at ? ` · ${new Date(String(a.submitted_at).replace(' ', 'T') + 'Z').toLocaleDateString()}` : ''}</span>
                    )}
                    {a.follow_up_date && <span className="text-xs text-stone-500">Follow-up {fmtDate(a.follow_up_date)}</span>}
                    {a.assignee_name && <span className="text-xs text-stone-500">· {a.assignee_name}</span>}
                    {onOpenAppeal && (
                      <button className="btn btn-outline btn-sm ml-auto" onClick={() => onOpenAppeal(a.id)}>Open appeal →</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {eraLines.length > 0 && (
          <div className="mt-6">
            <SectionTitle>ERA lines matched to this claim</SectionTitle>
            <div className="space-y-2">
              {eraLines.map((l) => (
                <div key={l.id} className="rounded-xl bg-stone-50 ring-1 ring-stone-200/70 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-stone-800">{l.era_payer || 'Payer'}</span>
                    {l.check_number && <span className="text-xs text-stone-500">Check/EFT {l.check_number}</span>}
                    {l.pay_date && <span className="text-xs text-stone-500">paid {fmtDate(l.pay_date)}</span>}
                    <span className={`badge ml-auto ${l.post_status === 'posted' ? 'badge-green' : l.post_status === 'ignored' ? 'badge-slate' : 'badge-amber'}`}>
                      {l.post_status === 'posted' ? 'Posted' : l.post_status === 'ignored' ? 'Ignored' : 'On hold'}
                    </span>
                  </div>
                  <div className="text-xs text-stone-500 mt-1">
                    Billed {fmtMoney2(l.billed)} · Paid {fmtMoney2(l.paid)} · Patient resp. {fmtMoney2(l.patient_resp)}
                    {l.service_start ? ` · Service ${fmtDate(l.service_start)}${l.service_end && l.service_end !== l.service_start ? ` – ${fmtDate(l.service_end)}` : ''}` : ''}
                  </div>
                  {l.denial_reason && <div className="text-xs text-rose-600 mt-1">{l.denial_reason}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {(claim.activity || []).length > 0 && (
          <div className="mt-6">
            <SectionTitle>Activity</SectionTitle>
            <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
              {claim.activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 text-[13px]">
                  <span className="text-stone-400 shrink-0 w-32 text-xs">
                    {new Date(a.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className="text-stone-600">
                    <strong className="text-stone-800">{a.user_name || 'System'}</strong> {String(a.action).replace(/_/g, ' ')}
                    {a.detail && <span className="text-stone-500"> — {a.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-7">
          {onEditClaim && <button className="btn btn-outline" onClick={() => onEditClaim(claim)}>Edit claim</button>}
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
