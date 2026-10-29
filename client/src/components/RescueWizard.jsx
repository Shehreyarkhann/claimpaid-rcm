import { useEffect, useState } from 'react';
import { api, fmtMoney2 } from '../api';
import { Modal, useToast } from './ui';

// Denial Rescue wizard (Phase 4, WS3) — a guided end-to-end pass over one
// denied claim, built entirely on the agent's own surfaces: the claim
// analysis (predictions), the read tools run outside chat via
// /api/agent/tools/run (eligibility, scrub), and the standard propose
// endpoint for the appeal draft. The wizard NEVER approves anything:
// step 4 creates a PENDING draft card and approval still happens on the
// standard cards. Step 5 is an honest manual checklist — no submission
// pipe is live yet, and the wizard says so rather than pretending.
// Progress lives in component state only (no tables).

const STEPS = ['Snapshot', 'Eligibility', 'Scrub', 'Appeal draft', 'Submit checklist'];

function pct(v) { return `${Math.round(v * 100)}%`; }

export default function RescueWizard({ claimId, onClose, onReviewDrafts }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [analysis, setAnalysis] = useState(null);
  const [analysisError, setAnalysisError] = useState('');
  const [elig, setElig] = useState(null);
  const [eligBusy, setEligBusy] = useState(false);
  const [scrub, setScrub] = useState(null);
  const [scrubBusy, setScrubBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [checks, setChecks] = useState({});
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let live = true;
    api.agent.claimAnalysis(claimId)
      .then((d) => { if (live) setAnalysis(d); })
      .catch((e) => { if (live) setAnalysisError(e.message || 'Analysis unavailable'); });
    return () => { live = false; };
  }, [claimId]);

  const runScrub = async () => {
    setScrubBusy(true);
    try {
      const r = await api.agent.runTool('scrub_claim', claimId);
      setScrub(r);
    } catch (e) {
      toast.error(e.message || 'The scrub could not run');
    } finally { setScrubBusy(false); }
  };

  // Scrub is deterministic and read-only — run it on first entry to step 3.
  useEffect(() => {
    if (step === 2 && !scrub && !scrubBusy) runScrub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const runEligibility = async () => {
    setEligBusy(true);
    try {
      const r = await api.agent.runTool('check_eligibility', claimId);
      setElig(r);
    } catch (e) {
      toast.error(e.message || 'The eligibility check could not run');
    } finally { setEligBusy(false); }
  };

  const createDraft = async () => {
    setDraftBusy(true);
    try {
      const r = await api.agent.propose({ kind: 'draft_appeal', claim_id: claimId });
      setDraft(r.action);
      toast.success('Draft created — review and approve it in the Agent tab');
    } catch (e) {
      toast.error(e.message || 'Could not create that draft');
    } finally { setDraftBusy(false); }
  };

  const claim = analysis?.claim;
  const overturn = analysis?.appeal_overturn;
  const draftRec = (analysis?.recommendations || []).find((r) => r.kind === 'draft_appeal');
  const eligOut = elig?.output || {};
  const scrubOut = scrub?.output || {};

  return (
    <Modal wide onClose={onClose}>
      <div className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 flex items-center justify-center text-xl shrink-0">🛟</div>
          <div className="min-w-0">
            <h3 className="font-display text-xl font-semibold text-stone-900">Denial Rescue{claim ? ` — ${claim.claim_number}` : ''}</h3>
            <p className="text-sm text-stone-500">Work this denial end to end. The agent checks and drafts; every save still waits for a person's approval.</p>
          </div>
        </div>

        {/* Stepper header */}
        <div className="flex flex-wrap gap-1.5 mt-5">
          {STEPS.map((label, i) => (
            <button key={label} onClick={() => setStep(i)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${i === step ? 'bg-[#17251F] text-white' : i < step ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-stone-100 text-stone-500'}`}>
              <span className={`w-4.5 h-4.5 w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center ${i === step ? 'bg-emerald-500 text-white' : 'bg-white ring-1 ring-stone-300 text-stone-500'}`}>{i < step ? '✓' : i + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-5 min-h-[260px]">
          {finished ? (
            <div className="text-center py-8">
              <img src="/app/claimpaid-icon.webp" alt="" className="motion-stamp w-28 h-28 mx-auto drop-shadow-xl" />
              <div className="font-display text-xl font-semibold text-stone-900 mt-5">Rescue pass complete</div>
              <p className="text-sm text-stone-500 mt-1.5 max-w-md mx-auto">
                {draft
                  ? 'The appeal draft is waiting as a pending card in the Agent tab — approve it there, then follow the submission checklist.'
                  : 'You have everything this claim needs checked. If a draft is still needed, it is one click in the Agent tab.'}
              </p>
              {draft && onReviewDrafts ? (
                <div className="flex gap-2 justify-center mt-5">
                  <button className="btn btn-primary" onClick={() => { onReviewDrafts(); onClose(); }}>
                    Review &amp; approve in Agent tab →
                  </button>
                  <button className="btn btn-outline" onClick={onClose}>Done</button>
                </div>
              ) : (
                <button className="btn btn-primary mt-5" onClick={onClose}>Done</button>
              )}
            </div>
          ) : step === 0 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Claim snapshot</div>
              {analysisError && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{analysisError}</div>}
              {!analysis && !analysisError && <p className="text-sm text-stone-400">Reading the claim…</p>}
              {claim && (
                <div className="space-y-2 text-sm">
                  <Row label="Claim">{claim.claim_number} · {claim.patient_name} · {claim.payer}</Row>
                  <Row label="Denied for">{claim.denial_reason || 'No reason recorded'}</Row>
                  <Row label="At stake">{fmtMoney2((claim.billed_amount || 0) - (claim.paid_amount || 0))} of {fmtMoney2(claim.billed_amount)} billed</Row>
                  {analysis.filing_risk && analysis.filing_risk.days_left != null && (
                    <Row label="Filing deadline">
                      <span className={analysis.filing_risk.state === 'critical' || analysis.filing_risk.state === 'expired' ? 'text-rose-700 font-medium' : ''}>
                        {analysis.filing_risk.days_left < 0 ? `Expired ${-analysis.filing_risk.days_left}d ago` : `${analysis.filing_risk.days_left} days left`} ({analysis.filing_risk.filing_deadline})
                      </span>
                    </Row>
                  )}
                  {overturn && overturn.value != null && (
                    <Row label="Appeal outlook">
                      Overturns {pct(overturn.value)} of the time here · n={overturn.sampleSize}
                      {overturn.angle ? <> · best angle: <b>{String(overturn.angle).replace(/_/g, ' ')}</b></> : null}
                      {overturn.label === 'early estimate' && <span className="text-amber-700"> · early estimate</span>}
                    </Row>
                  )}
                  {(!overturn || overturn.value == null) && (
                    <Row label="Appeal outlook">No decided appeals in this workspace yet — this one starts the record.</Row>
                  )}
                  <Row label="Scrub readiness">{analysis.scrub.score}/100 · {analysis.scrub.band_label} · {analysis.scrub.errors} errors, {analysis.scrub.warnings} warnings</Row>
                </div>
              )}
            </div>
          ) : step === 1 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Eligibility — was coverage actually active?</div>
              <p className="text-sm text-stone-600 mb-3">Runs the same vendor check as the Eligibility tab and stores it in Eligibility history. The result states its mode — a test-mode answer is not a live payer answer.</p>
              {!elig && (
                <button className="btn btn-primary" disabled={eligBusy} onClick={runEligibility}>{eligBusy ? 'Checking…' : '⚡ Run eligibility check'}</button>
              )}
              {elig && elig.is_error && (
                <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{eligOut.error}</div>
              )}
              {elig && !elig.is_error && (
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap gap-1.5">
                    <span className={`badge ${eligOut.coverage_active ? 'badge-green' : 'badge-rose'}`}>{eligOut.coverage_active ? 'Coverage active' : 'Coverage NOT active'}</span>
                    <span className={`badge ${eligOut.mode === 'live' ? 'badge-slate' : 'badge-amber'}`}>{eligOut.mode === 'live' ? `Live · ${eligOut.vendor}` : `${String(eligOut.mode || 'test').toUpperCase()} mode · ${eligOut.vendor} — not a live payer answer`}</span>
                  </div>
                  {eligOut.plan_name && <Row label="Plan">{eligOut.plan_name}{eligOut.plan_type ? ` · ${eligOut.plan_type}` : ''}{eligOut.group_number ? ` · group ${eligOut.group_number}` : ''}</Row>}
                  {(eligOut.copay_primary != null || eligOut.deductible_remaining != null) && (
                    <Row label="Benefits">
                      {eligOut.copay_primary != null ? `Copay $${eligOut.copay_primary}` : ''}
                      {eligOut.deductible_remaining != null ? `${eligOut.copay_primary != null ? ' · ' : ''}Deductible remaining $${eligOut.deductible_remaining}` : ''}
                    </Row>
                  )}
                  {(eligOut.aaa_errors || []).map((e, i) => (
                    <div key={i} className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                      Payer rejection {e.code}: {e.plain_terms}
                    </div>
                  ))}
                  <p className="text-xs text-stone-400">{eligOut.note}</p>
                </div>
              )}
            </div>
          ) : step === 2 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Scrub — what would bounce this claim?</div>
              {scrubBusy && !scrub && <p className="text-sm text-stone-400">Running the deterministic scrubber…</p>}
              {scrub && scrub.is_error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{scrubOut.error}</div>}
              {scrub && !scrub.is_error && (
                <div>
                  <div className="flex items-baseline gap-2 mb-3">
                    <span className="font-display text-2xl font-semibold text-stone-900">{scrubOut.score}/100</span>
                    <span className="text-sm text-stone-500">{scrubOut.band_label} · {scrubOut.errors?.length || 0} errors, {scrubOut.warnings?.length || 0} warnings</span>
                  </div>
                  {(scrubOut.errors || []).length === 0 && (scrubOut.warnings || []).length === 0 && (
                    <p className="text-sm text-emerald-700 font-medium">Clean — the scrubber found nothing to fix on this claim.</p>
                  )}
                  {(scrubOut.errors || []).map((f, i) => (
                    <div key={`e${i}`} className="flex gap-2.5 text-sm mb-2"><span className="badge badge-rose shrink-0">Error</span><span><b>{f.name}:</b> {f.fix}</span></div>
                  ))}
                  {(scrubOut.warnings || []).map((f, i) => (
                    <div key={`w${i}`} className="flex gap-2.5 text-sm mb-2"><span className="badge badge-amber shrink-0">Warning</span><span><b>{f.name}:</b> {f.fix}</span></div>
                  ))}
                </div>
              )}
            </div>
          ) : step === 3 ? (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Appeal draft — proposed, never auto-approved</div>
              {overturn && overturn.value != null && (
                <p className="text-sm text-stone-600 mb-3">
                  Appeals like this overturn {pct(overturn.value)} of the time here (n={overturn.sampleSize}{overturn.label === 'early estimate' ? ', early estimate' : ''}).
                  {overturn.angle ? <> The draft will argue the <b>{String(overturn.angle).replace(/_/g, ' ')}</b> angle — the best performer for this payer and reason.</> : null}
                </p>
              )}
              {draft ? (
                <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-200 px-4 py-3.5 text-sm">
                  <div className="font-medium text-emerald-900">Draft created — it's a pending card in the Agent tab.</div>
                  {draft.payload?.angle_source === 'learned' && draft.payload?.angle_stat && (
                    <div className="text-emerald-800 mt-1">Angle: {String(draft.payload.category || '').replace(/_/g, ' ')} — overturns {pct(draft.payload.angle_stat.value)} here (n={draft.payload.angle_stat.sampleSize}).</div>
                  )}
                  <div className="text-emerald-700 mt-1">Nothing has been saved to the claim yet — approving the card is what saves it, and submitting stays manual (next step).</div>
                  {onReviewDrafts && (
                    <button className="btn btn-primary btn-sm mt-3" onClick={() => { onReviewDrafts(); onClose(); }}>
                      Review &amp; approve in Agent tab →
                    </button>
                  )}
                </div>
              ) : draftRec && !draftRec.spawnable ? (
                <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200 px-4 py-3.5 text-sm">
                  <div className="font-medium text-stone-800">{draftRec.label}</div>
                  <div className="text-stone-500 mt-0.5">{draftRec.detail}</div>
                  {onReviewDrafts && /awaiting a decision/.test(draftRec.label) && (
                    <button className="btn btn-primary btn-sm mt-3" onClick={() => { onReviewDrafts(); onClose(); }}>
                      Review &amp; approve in Agent tab →
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-sm text-stone-600 mb-3">Create the appeal draft now. It lands in the Agent tab as a pending approval card with the full letter — this wizard does not approve it.</p>
                  <button className="btn btn-primary" disabled={draftBusy} onClick={createDraft}>{draftBusy ? 'Drafting…' : '✉️ Create appeal draft'}</button>
                </>
              )}
            </div>
          ) : (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Submission checklist — the honest manual last mile</div>
              <p className="text-sm text-stone-600 mb-3">ClaimPaid's submission pipe isn't live yet, so the appeal leaves the building the way it does today. Work this list:</p>
              <div className="space-y-2.5">
                {[
                  ['Approve the draft in the Agent tab', 'Approving saves the letter to the claim as a draft appeal — nothing is sent automatically.'],
                  ['Open the appeal in Denial Appeals', 'Review the letter once more and download or print it from there.'],
                  ['Submit via your clearinghouse or the payer portal', 'Use the same channel you submit claims through today; attach the enclosures the letter lists.'],
                  ['Set the follow-up date on the appeal', 'That puts it in your work queue, so the watchdog and the morning brief can chase it with you.'],
                ].map(([title, sub]) => (
                  <label key={title} className="flex gap-3 items-start rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-4 py-3 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={!!checks[title]} onChange={(e) => setChecks((c) => ({ ...c, [title]: e.target.checked }))} />
                    <span><span className="block text-sm font-medium text-stone-800">{title}</span><span className="block text-xs text-stone-500 mt-0.5">{sub}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {!finished && (
          <div className="flex items-center gap-2 mt-5 pt-4 border-t border-stone-100">
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            <div className="ml-auto flex gap-2">
              {step > 0 && <button className="btn btn-outline" onClick={() => setStep(step - 1)}>Back</button>}
              {step < STEPS.length - 1 && <button className="btn btn-ghost" onClick={() => setStep(step + 1)}>Skip this step</button>}
              {step < STEPS.length - 1
                ? <button className="btn btn-primary" onClick={() => setStep(step + 1)}>Continue →</button>
                : <button className="btn btn-primary" onClick={() => setFinished(true)}>Finish 🧾</button>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-stone-500 w-32 shrink-0">{label}</span>
      <span className="font-medium text-stone-800 min-w-0">{children}</span>
    </div>
  );
}
