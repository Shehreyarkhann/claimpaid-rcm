import { useEffect, useState } from 'react';
import { api, fmtMoney2 } from '../api';
import { Modal, useToast } from './ui';

// Payer-call copilot (Phase 5, WS2) — the Rescue wizard's visual
// language applied to the phone call itself. Step 1 is the deterministic
// brief the server builds from claim facts (nothing model-written:
// identifiers to have ready, questions keyed to the denial family, what
// a good outcome looks like, the escalation line). Step 2 logs the
// outcome — which lands on the claim timeline and sets the follow-up on
// the open appeal when one is implied.

const OUTCOME_OPTIONS = [
  ['promised_payment', 'Payment promised'],
  ['denied_upheld', 'Denial upheld'],
  ['info_requested', 'More info requested'],
  ['transferred', 'Transferred'],
  ['voicemail', 'Left voicemail'],
  ['other', 'Other'],
];

export default function CallCopilot({ claimId, onClose, onLogged }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ agent_name: '', reference_number: '', outcome: 'promised_payment', promised_date: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    let live = true;
    api.agent.callBrief(claimId)
      .then((d) => { if (live) setBrief(d.brief); })
      .catch((e) => { if (live) setError(e.message || 'The call brief could not be prepared'); });
    return () => { live = false; };
  }, [claimId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.agent.logCall(claimId, {
        agent_name: form.agent_name || undefined,
        reference_number: form.reference_number || undefined,
        outcome: form.outcome,
        promised_date: form.outcome === 'promised_payment' && form.promised_date ? form.promised_date : undefined,
        notes: form.notes || undefined,
      });
      setSaved(r);
      toast.success('Call logged on the claim timeline');
      if (onLogged) onLogged();
    } catch (e) {
      toast.error(e.message || 'Could not log that call');
    } finally {
      setSaving(false);
    }
  };

  const claim = brief?.claim;

  return (
    <Modal wide onClose={onClose}>
      <div className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 flex items-center justify-center text-xl shrink-0">📞</div>
          <div className="min-w-0">
            <h3 className="font-display text-xl font-semibold text-stone-900">Call the payer{claim ? ` — ${claim.payer}` : ''}</h3>
            <p className="text-sm text-stone-500">A script built from this claim's facts — then log the outcome so the follow-up never gets lost.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-5">
          {['Call brief', 'Log the outcome'].map((label, i) => (
            <button key={label} onClick={() => setStep(i)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${i === step ? 'bg-[#17251F] text-white' : i < step ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-stone-100 text-stone-500'}`}>
              <span className={`w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center ${i === step ? 'bg-emerald-500 text-white' : 'bg-white ring-1 ring-stone-300 text-stone-500'}`}>{i < step ? '✓' : i + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-5 min-h-[260px]">
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
          {!brief && !error && <p className="text-sm text-stone-400">Preparing the brief…</p>}
          {brief && step === 0 && (
            <div className="space-y-4">
              <div className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-4 py-3 text-sm">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 block mb-1">Open with</span>
                <span className="text-stone-800">“{brief.opening_line}”</span>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Have ready</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {brief.have_ready.map((h) => (
                    <div key={h.label} className="rounded-xl bg-white ring-1 ring-stone-200 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide text-stone-400">{h.label}</div>
                      <div className="text-sm font-medium text-stone-800 truncate" title={h.value}>{h.value}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">
                  Ask — {brief.family_label} denial{brief.claim?.denial_reason ? `: ${brief.claim.denial_reason}` : ''}
                </div>
                <ol className="space-y-1.5">
                  {brief.questions.map((q, i) => (
                    <li key={i} className="motion-fade-slide flex items-baseline gap-2.5 text-sm" style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
                      <span className="font-display font-semibold text-emerald-700 w-5 shrink-0">{i + 1}.</span>
                      <span className="text-stone-700">{q}</span>
                    </li>
                  ))}
                </ol>
              </div>
              {brief.filing_risk && brief.filing_risk.days_left != null && (
                <p className="text-sm">
                  <span className="text-stone-500">Filing deadline: </span>
                  <span className={`font-medium ${brief.filing_risk.state === 'critical' || brief.filing_risk.state === 'expired' ? 'text-rose-700' : 'text-stone-800'}`}>
                    {brief.filing_risk.days_left < 0 ? `expired ${-brief.filing_risk.days_left}d ago` : `${brief.filing_risk.days_left} days left`} ({brief.filing_risk.filing_deadline})
                  </span>
                  <span className="text-stone-500"> — if this call doesn't resolve it, the written appeal protects the deadline.</span>
                </p>
              )}
              <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-200 px-4 py-3 text-sm">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700 block mb-1">A good outcome looks like</span>
                <span className="text-emerald-900">{brief.good_outcome}</span>
              </div>
              <p className="text-[13px] text-stone-500 italic">{brief.escalation}</p>
              {(brief.playbook || []).length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">From the payer playbook</div>
                  <div className="space-y-2">
                    {brief.playbook.map((p, i) => (
                      <div key={i} className="rounded-xl bg-white ring-1 ring-stone-200 px-4 py-3">
                        <div className="text-sm font-medium text-stone-800">{p.title}</div>
                        <div className="text-[13px] text-stone-500 mt-0.5 whitespace-pre-wrap">{p.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {claim && (
                <p className="text-xs text-stone-400">At stake on this claim: {fmtMoney2((claim.billed_amount || 0) - (claim.paid_amount || 0))} of {fmtMoney2(claim.billed_amount)} billed.</p>
              )}
            </div>
          )}
          {brief && step === 1 && (
            saved ? (
              <div className="text-center py-8">
                <img src="/app/claimpaid-icon.webp" alt="" className="motion-stamp w-24 h-24 mx-auto drop-shadow-xl" />
                <div className="font-display text-xl font-semibold text-stone-900 mt-5">Call logged</div>
                <p className="text-sm text-stone-500 mt-1.5 max-w-md mx-auto">
                  It's on the claim's timeline now.
                  {saved.follow_up
                    ? saved.follow_up.applied_to === 'appeal'
                      ? ` Follow-up set on the open appeal for ${saved.follow_up.date} — it will surface in the work queue if it slips.`
                      : ` Follow-up noted for ${saved.follow_up.date} on the call log (this claim has no open appeal to attach it to).`
                    : ' No follow-up was implied by this outcome.'}
                </p>
                <button className="btn btn-primary mt-5" onClick={onClose}>Done</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">Rep's name</label>
                    <input className="input" value={form.agent_name} onChange={set('agent_name')} placeholder="Who did you speak with?" /></div>
                  <div><label className="label">Reference number</label>
                    <input className="input" value={form.reference_number} onChange={set('reference_number')} placeholder="Call reference / confirmation" /></div>
                </div>
                <div>
                  <label className="label">Outcome</label>
                  <div className="flex flex-wrap gap-1.5">
                    {OUTCOME_OPTIONS.map(([v, l]) => (
                      <button key={v} onClick={() => setForm((f) => ({ ...f, outcome: v }))}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${form.outcome === v ? 'bg-[#17251F] text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>{l}</button>
                    ))}
                  </div>
                </div>
                {form.outcome === 'promised_payment' && (
                  <div><label className="label">Payment promised by</label>
                    <input type="date" className="input max-w-[220px]" value={form.promised_date} onChange={set('promised_date')} /></div>
                )}
                <div><label className="label">Notes</label>
                  <textarea className="input" rows={3} value={form.notes} onChange={set('notes')} placeholder="What did they say? Deadlines, fax numbers, names…" /></div>
                <p className="text-[11px] text-stone-400">Logging writes this to the claim's timeline. A promised date — or an outcome that implies a check-back — sets the follow-up on the claim's open appeal, so it lands in the work queue.</p>
              </div>
            )
          )}
        </div>

        {!saved && (
          <div className="flex items-center gap-2 mt-5 pt-4 border-t border-stone-100">
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
            <div className="ml-auto flex gap-2">
              {step === 1 && <button className="btn btn-outline" onClick={() => setStep(0)}>Back to brief</button>}
              {step === 0
                ? <button className="btn btn-primary" disabled={!brief} onClick={() => setStep(1)}>Log the outcome →</button>
                : <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save call log 📞'}</button>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
