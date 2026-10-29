import { useState, useEffect, useRef, useCallback } from 'react';
import { api, fmtMoney2 } from '../api';
import { useAuth } from '../auth';
import { PageHeader, EmptyState, Skeleton, useToast } from '../components/ui';
import DocumentIntake from '../components/DocumentIntake';
import AuditRunner from '../components/AuditReport';
import ClaimDetailsModal from '../components/ClaimDetailsModal';

// ClaimPaid Agent (Phase 1) — the in-app RCM agent. It reads the queue with
// tools, drafts work, and proposes actions as approval cards; nothing is
// saved until a person approves. Dark-shipped: when the server answers
// AGENT_DISABLED (flag off / no model key), this page renders a clean
// "not enabled" state — that's what production shows until the key lands.

const TOOL_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/>
  </svg>
);

const STATUS_META = {
  pending: { pill: 'badge-amber', label: 'Awaiting your decision' },
  executed: { pill: 'badge-green', label: 'Approved · saved' },
  rejected: { pill: 'badge-slate', label: 'Rejected · nothing saved' },
  failed: { pill: 'badge-rose', label: 'Approved · save failed' },
  approved: { pill: 'badge-green', label: 'Approved' },
};

function ToolChips({ events }) {
  if (!events || !events.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {events.map((e, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-stone-500 bg-stone-100 border border-stone-200 rounded-full px-2 py-0.5">
          <span className="text-emerald-600">{TOOL_ICON}</span>{e.label || e.tool}
        </span>
      ))}
    </div>
  );
}

const KIND_META = {
  draft_appeal: {
    pendingNote: 'The agent drafted this — nothing has been saved. Approving saves it to the claim as a draft appeal (never submitted to the payer).',
    approveLabel: 'Approve & save draft',
    executedNote: (a) => (a.result?.appeal_id ? 'Saved as an appeal draft on the claim — open it in Denial Appeals to edit, print, or mark submitted.' : null),
  },
  apply_codes: {
    pendingNote: 'The agent proposed these codes from the quote-verified coding engine — nothing has been applied. Approving applies ONLY the Valid codes listed to the claim; Review-status codes are never applied.',
    approveLabel: 'Approve & apply codes',
    executedNote: (a) => (a.result?.applied_codes?.length
      ? `Applied to the claim: ${a.result.applied_codes.map((c) => String(c).split(':').pop()).join(', ')}.`
      : null),
  },
  resolve_exception: {
    pendingNote: 'The agent proposes resolving this ERA exception with the disposition below — the math is computed from the remittance itself. Approving posts/ignores the line through the standard ERA path; rejecting leaves it untouched in the ERA inbox.',
    approveLabel: 'Approve & resolve',
    executedNote: (a) => (a.result?.posted
      ? `Posted to the claim — the claim is now ${a.result.new_status || 'updated'}.`
      : a.result?.ignored ? 'Line written off (ignored) — the remittance is updated.' : null),
  },
  apply_intake: {
    pendingNote: 'A person reviewed this extracted document and proposed applying it. The numbers were transcribed from the paper and checked deterministically — approving performs exactly what the preview says; rejecting dismisses the document and creates nothing.',
    approveLabel: 'Approve & apply',
    executedNote: (a) => (a.result?.kind === 'remittance'
      ? `Held remittance created in the ERA inbox (${a.result.lines || 0} lines, ${a.result.matched || 0} matched) — nothing has posted; the ERA tab takes it from there.`
      : a.result?.kind === 'denial_letter'
        ? `Denial recorded on claim ${a.result.claim_number || ''}${a.result.draft_action_id ? ' and an appeal draft was proposed as its own card.' : ''}`
        : null),
  },
};

export function ActionCard({ action, busy, onDecide, onShowClaimDetails, selectable, selected, onToggleSelect }) {
  const meta = STATUS_META[action.status] || STATUS_META.pending;
  const kind = KIND_META[action.kind] || KIND_META.draft_appeal;
  const decided = action.status !== 'pending';
  const executedNote = action.status === 'executed' ? kind.executedNote(action) : null;
  // Phase 4 feel: when THIS card flips pending -> executed in front of
  // the user, the paid stamp slams on (motion.css, reduced-motion safe).
  const prevStatus = useRef(action.status);
  const [stamping, setStamping] = useState(false);
  useEffect(() => {
    if (prevStatus.current === 'pending' && action.status === 'executed') {
      setStamping(true);
      const t = setTimeout(() => setStamping(false), 1700);
      return () => clearTimeout(t);
    }
    prevStatus.current = action.status;
  }, [action.status]);
  return (
    <div className={`relative rounded-2xl border p-4 ${action.status === 'pending' ? 'border-amber-300 bg-amber-50/70' : 'border-stone-200 bg-[#FFFDF8]'}`}>
      {stamping && (
        <img src="/app/claimpaid-icon.webp" alt="" aria-hidden="true"
          className="motion-stamp absolute right-4 top-3 w-16 h-16 pointer-events-none drop-shadow-lg z-10" />
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {selectable && !decided && (
          <input type="checkbox" checked={!!selected} onChange={() => onToggleSelect && onToggleSelect(action.id)}
            aria-label={`Select ${action.title}`} className="w-4 h-4 accent-emerald-600 shrink-0" />
        )}
        <span className="text-sm font-bold text-stone-900">{action.title}</span>
        <span className={`badge ${meta.pill}`}>{meta.label}</span>
        {action.auto_approved && <span className="badge badge-blue">Auto-approved by policy</span>}
        {action.payload?.category && <span className="badge badge-slate">{action.payload.category.replace(/_/g, ' ')}</span>}
        {action.payload?.disposition_label && <span className="badge badge-slate">{action.payload.disposition_label}</span>}
      </div>
      {action.status === 'pending' && (
        <p className="text-xs text-amber-800 mb-2">{kind.pendingNote}</p>
      )}
      <div className="max-h-64 overflow-auto rounded-xl border border-stone-200 bg-white p-3.5">
        <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-stone-700">{action.preview}</pre>
      </div>
      {executedNote && (
        <p className="text-xs text-emerald-700 mt-2 font-medium">{executedNote}</p>
      )}
      {action.status === 'failed' && action.result?.error && (
        <p className="text-xs text-rose-600 mt-2 font-medium">{action.result.error}</p>
      )}
      {!decided && (
        <div className="flex gap-2 mt-3">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide(action, 'approve')}>
            {busy ? 'Saving…' : kind.approveLabel}
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => onDecide(action, 'reject')}>
            Reject
          </button>
        </div>
      )}
      {action.payload?.claim_id && onShowClaimDetails && (
        <div className="mt-2.5">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => onShowClaimDetails(action.payload.claim_id)}>
            Claim details
          </button>
        </div>
      )}
    </div>
  );
}

// Deploy #97: the action buttons on plan rows and alerts-panel rows —
// Open claim (App deep link into the Claims page) and, for denials,
// Draft appeal (propose -> the card lands in the approvals section) or
// "Draft waiting ↑" when a pending draft for the claim already exists.
export function pendingDraftFor(pendingActions, claimId) {
  if (claimId == null) return null;
  return (pendingActions || []).find((a) => a.kind === 'draft_appeal' && a.status === 'pending'
    && a.payload && a.payload.claim_id === claimId) || null;
}

function ClaimRowActions({ claimId, denied, pendingActions, proposingId, onOpenClaim, onProposeDraft, onScrollApprovals, onShowDetails }) {
  if (claimId == null) return null;
  const waiting = denied ? pendingDraftFor(pendingActions, claimId) : null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {denied && (waiting ? (
        <button type="button" className="btn btn-outline btn-sm" onClick={onScrollApprovals}>Draft waiting ↑</button>
      ) : (
        <button type="button" className="btn btn-dark btn-sm" disabled={proposingId === claimId}
          onClick={() => onProposeDraft && onProposeDraft(claimId)}>
          {proposingId === claimId ? 'Drafting…' : 'Draft appeal'}
        </button>
      ))}
      {onShowDetails && (
        <button type="button" className="btn btn-outline btn-sm" onClick={() => onShowDetails(claimId)}>Details</button>
      )}
      {onOpenClaim && (
        <button type="button" className="btn btn-outline btn-sm" onClick={() => onOpenClaim(claimId)}>Open claim</button>
      )}
    </span>
  );
}

// Deploy #97: the approvals section — every pending agent action in the
// org, from the dedicated endpoint. Brief-proposed, chat-proposed,
// wizard-proposed and intake cards ALL render here and only here, so a
// pending draft can never be counted by the alerts strip yet visible
// nowhere (the previous-day brief / conversation-less orphan bug).
function ApprovalsSection({ actions, decidingId, onDecide, onShowClaimDetails, selectedIds, onToggleSelect, onSelectAll, onBatchDecide, batchBusy, batchSummary }) {
  if (!actions.length) return null;
  const pendingCount = actions.filter((a) => a.status === 'pending').length;
  const selectedCount = (selectedIds || []).length;
  return (
    <div id="agent-approvals" className="card p-5 mb-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="font-display font-semibold text-stone-900 text-lg">Awaiting your approval</div>
        {pendingCount > 0 && (
          <span className="bg-amber-500 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">{pendingCount} pending</span>
        )}
        <div className="text-xs text-stone-400">Every draft the agent prepares — brief, chat, wizard, intake — waits here. Nothing saves until you decide.</div>
      </div>
      {pendingCount > 1 && (
        <div className="flex flex-wrap items-center gap-2 mt-3 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2">
          <button type="button" className="btn btn-outline btn-sm" onClick={onSelectAll}>
            {selectedCount === pendingCount ? 'Clear selection' : `Select all ${pendingCount}`}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!selectedCount || batchBusy}
            onClick={() => onBatchDecide('approve')}>
            {batchBusy ? 'Working…' : `Approve selected${selectedCount ? ` (${selectedCount})` : ''}`}
          </button>
          <button type="button" className="btn btn-outline btn-sm" disabled={!selectedCount || batchBusy}
            onClick={() => onBatchDecide('reject')}>
            Reject selected
          </button>
          {batchSummary && <span className="text-xs text-stone-500">{batchSummary}</span>}
        </div>
      )}
      <div className="space-y-3 mt-4">
        {actions.map((a) => (
          <ActionCard key={a.id} action={a} busy={decidingId === a.id} onDecide={onDecide} onShowClaimDetails={onShowClaimDetails}
            selectable selected={(selectedIds || []).includes(a.id)} onToggleSelect={onToggleSelect} />
        ))}
      </div>
    </div>
  );
}

// Deploy #101: the auto-approved review stream + the owner's policy
// controls. Drafts the policy executed appear here with the exact
// policy + win-history snapshot that qualified them; each can be voided
// while its appeal is still an unworked draft.
function AutoApprovedSection({ actions, onVoid, voidingId, isOwner, policy, onSavePolicy, policyBusy }) {
  const [form, setForm] = useState(null);
  useEffect(() => { if (policy) setForm({ ...policy }); }, [policy]);
  if (!isOwner && !actions.length) return null;
  return (
    <div id="agent-auto-approved" className="card p-5 mb-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="font-display font-semibold text-stone-900 text-lg">Auto-approved</div>
        <div className="text-xs text-stone-400">Drafts your approval policy executed on its own — review them here; voiding removes the draft while it is still unworked.</div>
      </div>
      {isOwner && form && (
        <div className="mt-3 rounded-xl border border-stone-200 bg-stone-50 p-3.5">
          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
            <input type="checkbox" checked={!!form.enabled} className="w-4 h-4 accent-emerald-600"
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
            Auto-approve appeal drafts that clear my bar
          </label>
          <div className="flex flex-wrap gap-3 mt-3">
            <label className="text-xs text-stone-500">Max claim amount ($)
              <input type="number" min="1" className="input !py-1.5 mt-1 !w-36" value={form.max_amount ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, max_amount: e.target.value === '' ? null : Number(e.target.value) }))} />
            </label>
            <label className="text-xs text-stone-500">Min decided appeals (history)
              <input type="number" min="1" max="1000" className="input !py-1.5 mt-1 !w-36" value={form.min_sample ?? 5}
                onChange={(e) => setForm((f) => ({ ...f, min_sample: Number(e.target.value) }))} />
            </label>
            <label className="text-xs text-stone-500">Min win rate (0–1)
              <input type="number" min="0" max="1" step="0.05" className="input !py-1.5 mt-1 !w-28" value={form.min_rate ?? 0.7}
                onChange={(e) => setForm((f) => ({ ...f, min_rate: Number(e.target.value) }))} />
            </label>
            <button type="button" className="btn btn-dark btn-sm self-end" disabled={policyBusy} onClick={() => onSavePolicy(form)}>
              {policyBusy ? 'Saving…' : 'Save policy'}
            </button>
          </div>
          <p className="text-[11px] text-stone-400 mt-2">A draft auto-approves only when the claim is at or under the max amount AND this workspace's own decided appeals for that payer + denial reason clear both history bars. No history, no auto-approval. Policy changes are audit-logged.</p>
        </div>
      )}
      {actions.length === 0 ? (
        <p className="text-sm text-stone-400 mt-3">Nothing has been auto-approved yet.</p>
      ) : (
        <div className="space-y-2.5 mt-4">
          {actions.map((a) => {
            const snap = a.auto_snapshot || {};
            const pred = snap.prediction || {};
            return (
              <div key={a.id} className="rounded-xl border border-stone-200 bg-[#FFFDF8] px-3.5 py-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-stone-800">{a.title}</span>
                {a.status === 'executed' && <span className="badge badge-green">Saved as draft</span>}
                {a.status === 'voided' && <span className="badge badge-slate">Voided</span>}
                {a.status === 'failed' && <span className="badge badge-rose">Save failed</span>}
                <span className="text-xs text-stone-500">
                  {pred.value != null ? `Win history ${Math.round(pred.value * 100)}% (n=${pred.sampleSize})` : '—'}
                  {snap.claim_amount != null ? ` · claim $${Number(snap.claim_amount).toLocaleString()}` : ''}
                  {a.executed_at ? ` · ${new Date(String(a.executed_at).replace(' ', 'T') + 'Z').toLocaleString()}` : ''}
                </span>
                {a.status === 'executed' && (
                  <button type="button" className="btn btn-outline btn-sm ml-auto" disabled={voidingId === a.id}
                    onClick={() => onVoid(a)}>
                    {voidingId === a.id ? 'Voiding…' : 'Void draft'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BriefSection({ brief, pendingActions, onOpenClaim, onProposeDraft, proposingId, onScrollApprovals, onShowDetails }) {
  const w = brief.while_away || {};
  const tiles = [
    { label: 'New denials', value: w.new_denials ? w.new_denials.count : 0 },
    {
      label: 'ERA posted',
      value: w.era_postings ? w.era_postings.count : 0,
      sub: w.era_postings && w.era_postings.total_paid ? `$${Number(w.era_postings.total_paid).toLocaleString()} paid` : null,
    },
    {
      label: 'Exceptions on hold',
      value: w.era_exceptions ? w.era_exceptions.on_hold_count : 0,
      sub: w.era_exceptions && w.era_exceptions.new_count ? `${w.era_exceptions.new_count} new` : null,
    },
    { label: 'Follow-ups passed', value: w.followups_passed ? w.followups_passed.count : 0 },
  ];
  const dateLabel = (() => {
    try {
      return new Date(`${brief.brief_date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch { return brief.brief_date; }
  })();
  // Queue clear (Phase 4, reworked #97): the brief proposed drafts and
  // none of those ids are still pending in the GLOBAL pending list —
  // the brief no longer carries its own card list to compare against.
  const proposedIds = brief.proposed_draft_action_ids || [];
  const queueClear = proposedIds.length > 0
    && !pendingActions.some((a) => a.status === 'pending' && proposedIds.includes(a.id));
  return (
    <div className="card p-5 mb-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="font-display font-semibold text-stone-900 text-lg">Morning brief</div>
        <div className="text-xs text-stone-400">{dateLabel} · while you were away</div>
        {queueClear && (
          <span className="ml-auto inline-flex items-center gap-2 text-emerald-700 font-semibold text-sm">
            <img src="/app/claimpaid-icon.webp" alt="" aria-hidden="true" className="motion-stamp w-8 h-8" />
            Queue clear
          </span>
        )}
      </div>
      {brief.summary && <p className="mt-2 text-sm leading-relaxed text-stone-700">{brief.summary}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3 py-2.5">
            <div className="font-display text-xl font-semibold text-stone-900">{t.value}</div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">{t.label}</div>
            {t.sub && <div className="text-[11px] text-emerald-700 font-medium mt-0.5">{t.sub}</div>}
          </div>
        ))}
      </div>
      {w.re_denied && w.re_denied.count > 0 && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/70 px-3.5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-rose-700 mb-1.5">
            Appeals re-denied — {w.re_denied.count} payer answer{w.re_denied.count === 1 ? '' : 's'} to respond to
          </div>
          <div className="space-y-1.5">
            {(w.re_denied.highlights || []).map((h) => (
              <div key={h.appeal_id || h.claim_id} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-stone-800">{h.claim_number}</span>
                  {h.denial_reason && <span className="text-stone-500"> — {h.denial_reason}</span>}
                  {h.amount != null && <span className="text-stone-500"> · ${Number(h.amount).toLocaleString()}</span>}
                </span>
                <ClaimRowActions
                  claimId={h.claim_id != null ? h.claim_id : null}
                  denied
                  pendingActions={pendingActions}
                  proposingId={proposingId}
                  onOpenClaim={onOpenClaim}
                  onProposeDraft={onProposeDraft}
                  onScrollApprovals={onScrollApprovals}
                  onShowDetails={onShowDetails}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {brief.plan && brief.plan.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Today's plan</div>
          <ol className="space-y-1.5">
            {brief.plan.map((p, i) => (
              <li key={p.key || p.rank} className="motion-fade-slide flex items-center gap-2.5 text-sm" style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
                <span className="font-display font-semibold text-emerald-700 w-5 shrink-0">{p.rank}.</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-stone-800">{p.title}</span>
                  {p.reason && <span className="text-stone-500"> — {p.reason}</span>}
                </span>
                {p.amount != null && <span className="shrink-0 font-medium text-stone-700">${Number(p.amount).toLocaleString()}</span>}
                <ClaimRowActions
                  claimId={p.claim_id != null ? p.claim_id : null}
                  denied={p.type === 'denial'}
                  pendingActions={pendingActions}
                  proposingId={proposingId}
                  onOpenClaim={onOpenClaim}
                  onProposeDraft={onProposeDraft}
                  onScrollApprovals={onScrollApprovals}
                  onShowDetails={onShowDetails}
                />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// Manager's agent (Phase 5, WS3) — rendered ONLY when the owner-gated
// endpoint succeeds. Members get a 403 and this section never mounts;
// there is no client-side role check to get wrong.
function TeamSection({ onShowDetails }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    api.agent.teamInsights()
      .then((d) => { if (live) setData(d); })
      .catch(() => { /* members + failures: section stays hidden */ });
    return () => { live = false; };
  }, []);
  if (!data) return null;
  return (
    <div className="card p-5 mt-5">
      <div className="flex items-baseline gap-3 flex-wrap">
        <div className="font-display font-semibold text-stone-900 text-lg">Team</div>
        <div className="text-xs text-stone-400">Computed from the worklist, appeals, and the agent's approval ledger — no estimates</div>
      </div>
      <div className="overflow-x-auto mt-4 rounded-xl border border-stone-200">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2">Teammate</th><th className="px-3 py-2 text-right">Open items</th>
              <th className="px-3 py-2 text-right">Overdue follow-ups</th><th className="px-3 py-2 text-right">Approvals waiting</th>
              <th className="px-3 py-2 text-right">Appeals decided</th><th className="px-3 py-2 text-right">Win rate</th>
              <th className="px-3 py-2 text-right">Agent drafts ✓ / ✗</th>
            </tr>
          </thead>
          <tbody>
            {(data.users || []).map((u) => (
              <tr key={u.user_id} className="border-t border-stone-100">
                <td className="px-3 py-2">
                  <span className="font-medium text-stone-800">{u.name}</span>
                  <span className="badge badge-slate ml-2">{u.role}</span>
                </td>
                <td className="px-3 py-2 text-right">{u.open_worklist_items}</td>
                <td className={`px-3 py-2 text-right ${u.overdue_followups > 0 ? 'text-rose-700 font-medium' : ''}`}>
                  {u.overdue_followups}{u.overdue_amount > 0 ? ` · ${fmtMoney2(u.overdue_amount)}` : ''}
                </td>
                <td className="px-3 py-2 text-right">{u.pending_approvals}</td>
                <td className="px-3 py-2 text-right">{u.appeals_decided}</td>
                <td className="px-3 py-2 text-right">{u.win_rate != null ? `${Math.round(u.win_rate * 100)}%` : '—'}</td>
                <td className="px-3 py-2 text-right">{u.agent_drafts_approved} / {u.agent_drafts_rejected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(data.suggestions || []).length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Reassignment suggestions</div>
          <div className="space-y-2">
            {data.suggestions.map((s) => (
              <div key={s.claim_id} className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-stone-800">Move claim {s.claim_number}</span>
                  <span className="text-stone-600"> ({fmtMoney2(s.balance)}, filing deadline in {s.days_left}d) from <b>{s.from_name}</b> to <b>{s.to_name}</b> — {s.reason}</span>
                </span>
                {onShowDetails && (
                  <button type="button" className="btn btn-outline btn-sm shrink-0" onClick={() => onShowDetails(s.claim_id)}>Details</button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-stone-400 mt-1.5">Suggestions only — reassign the appeal on the claim when you're ready; the agent never moves work itself.</p>
        </div>
      )}

      {(data.stalled || []).length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Stalled — no activity in 7+ days</div>
          <div className="space-y-1.5">
            {data.stalled.slice(0, 10).map((c) => (
              <div key={c.claim_id} className="flex items-center gap-2 text-sm">
                <span className="font-medium text-stone-800">{c.claim_number}</span>
                <span className="text-stone-500 truncate">{c.patient_name} · {c.payer} · idle {c.idle_days}d{c.owner_name ? ` · with ${c.owner_name}` : ' · unassigned'}</span>
                <span className="ml-auto shrink-0 font-medium text-stone-700">{fmtMoney2(c.balance)}</span>
                {onShowDetails && (
                  <button type="button" className="btn btn-outline btn-sm shrink-0" onClick={() => onShowDetails(c.claim_id)}>Details</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Agent({ onUpgrade, onOpenClaim, onOpenEra, initialSection, onConsumed }) {
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState(null);
  const [pendingActions, setPendingActions] = useState([]);
  const [autoActions, setAutoActions] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [voidingId, setVoidingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchSummary, setBatchSummary] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [proposingId, setProposingId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [actions, setActions] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [decidingId, setDecidingId] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [detailsClaimId, setDetailsClaimId] = useState(null);
  const showClaimDetails = useCallback((claimId) => { if (claimId != null) setDetailsClaimId(claimId); }, []);
  // Deploy #89: the 402 AI-use cap gets a persistent in-page upgrade
  // notice (the server's plan-limit body), not a vanishing error toast.
  const [quotaNotice, setQuotaNotice] = useState(null);
  const threadRef = useRef(null);
  const threadCardRef = useRef(null);
  const composerRef = useRef(null);

  const goBilling = () => {
    if (onUpgrade) onUpgrade();
    else window.location.href = '/app/?billing=open';
  };

  const scrollDown = () => {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  const loadConversations = useCallback(async () => {
    try {
      const r = await api.agent.conversations();
      setConversations(r.conversations || []);
      setDisabled(false);
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') { setDisabled(true); return; }
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConversations().catch(() => setLoading(false)); }, [loadConversations]);

  // Deploy #97: ONE shared refresh for the page's three live surfaces —
  // the global pending-approvals list, the watchdog alerts strip, and
  // the morning brief. It runs on mount, on window focus, and after
  // every decide / propose on this page, so a card created or decided
  // anywhere shows up (or leaves) everywhere at once. keepDecided keeps
  // a just-decided card on screen in its decided state (the stamp
  // animation + result note) instead of vanishing mid-gesture; a plain
  // refresh (mount / focus) replaces the list wholesale.
  // Brief failures (other than disabled) just leave the last brief —
  // the chat below is unaffected; alerts failures leave the strip as-is.
  const refreshSurfaces = useCallback(async ({ keepDecided = false } = {}) => {
    try {
      const r = await api.agent.pendingActions();
      setPendingActions((prev) => {
        const fresh = r.actions || [];
        if (!keepDecided) return fresh;
        const freshIds = new Set(fresh.map((a) => a.id));
        const decided = prev.filter((a) => a.status !== 'pending' && !freshIds.has(a.id));
        return [...fresh, ...decided];
      });
      setDisabled(false);
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') setDisabled(true);
    }
    try {
      const r = await api.agent.alerts();
      setAlerts(r.items || null);
    } catch { /* strip stays as-is */ }
    try {
      const r = await api.agent.brief();
      setBrief(r.brief || null);
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') setDisabled(true);
    }
    try {
      const r = await api.agent.autoApproved();
      setAutoActions(r.actions || []);
    } catch { /* stream stays as-is */ }
    if (isOwner) {
      try {
        const r = await api.agent.policy();
        setPolicy(r.policy || null);
      } catch { /* policy card stays hidden */ }
    }
  }, [isOwner]);

  useEffect(() => { refreshSurfaces(); }, [refreshSurfaces]);

  useEffect(() => {
    const onFocus = () => refreshSurfaces();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshSurfaces]);

  const scrollToApprovals = useCallback(() => {
    setTimeout(() => {
      const el = document.getElementById('agent-approvals');
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }, []);

  // Arriving from the Rescue wizard's "Review & approve" route: once the
  // approvals section exists (a pending card is loaded), land on it —
  // once, then hand the deep link back as consumed.
  const focusConsumedRef = useRef(false);
  useEffect(() => {
    if (initialSection !== 'approvals' || focusConsumedRef.current) return;
    if (!pendingActions.some((a) => a.status === 'pending')) return;
    focusConsumedRef.current = true;
    scrollToApprovals();
    if (onConsumed) onConsumed();
  }, [initialSection, pendingActions, scrollToApprovals, onConsumed]);

  // Draft appeal from a plan / alerts row: propose through the standard
  // endpoint (the draft is a PENDING card — proposing never approves),
  // refresh every surface, and land the user on the new card.
  const proposeDraft = async (claimId) => {
    if (claimId == null || proposingId != null) return;
    setProposingId(claimId);
    try {
      const r = await api.agent.propose({ kind: 'draft_appeal', claim_id: claimId });
      if (r.action && r.action.status === 'executed' && r.action.auto_approved) {
        toast.success('Draft created — your auto-approval policy already saved it (see Auto-approved below)');
      } else {
        toast.success('Draft created — it is waiting in Awaiting your approval');
      }
      await refreshSurfaces({ keepDecided: true });
      scrollToApprovals();
    } catch (e) {
      toast.error(e.message || 'Could not draft that appeal');
    } finally {
      setProposingId(null);
    }
  };

  // Deploy #101: batch selection + decide, and the auto-stream handlers.
  const toggleSelect = (id) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  const selectAllPending = () => {
    const pendingIds = pendingActions.filter((a) => a.status === 'pending').map((a) => a.id);
    setSelectedIds((ids) => (ids.length === pendingIds.length ? [] : pendingIds));
  };
  const batchDecide = async (decision) => {
    if (!selectedIds.length || batchBusy) return;
    setBatchBusy(true);
    setBatchSummary(null);
    try {
      const r = await api.agent.batchDecide(selectedIds, decision);
      const s = r.summary || {};
      const parts = [];
      if (s.executed) parts.push(`${s.executed} approved & saved`);
      if (s.rejected) parts.push(`${s.rejected} rejected`);
      if (s.failed) parts.push(`${s.failed} failed`);
      if (s.skipped) parts.push(`${s.skipped} already decided (skipped)`);
      if (s.missing) parts.push(`${s.missing} no longer found`);
      setBatchSummary(`Batch ${decision}: ${parts.join(' · ') || 'nothing changed'}`);
      toast.success(`Batch ${decision} complete`);
      setSelectedIds([]);
      refreshSurfaces({ keepDecided: true });
    } catch (e) {
      toast.error(e.message || 'Batch decision failed');
    } finally {
      setBatchBusy(false);
    }
  };
  const voidAuto = async (action) => {
    setVoidingId(action.id);
    try {
      await api.agent.voidAuto(action.id);
      toast.success('Draft voided — nothing remains saved from it');
      refreshSurfaces({ keepDecided: true });
    } catch (e) {
      toast.error(e.message || 'Could not void that draft');
    } finally {
      setVoidingId(null);
    }
  };
  const savePolicy = async (form) => {
    setPolicyBusy(true);
    try {
      const r = await api.agent.updatePolicy(form);
      setPolicy(r.policy || null);
      toast.success('Approval policy saved');
    } catch (e) {
      toast.error(e.message || 'Could not save the policy');
    } finally {
      setPolicyBusy(false);
    }
  };

  const decidePending = async (action, decision) => {
    setDecidingId(action.id);
    try {
      const r = decision === 'approve' ? await api.agent.approveAction(action.id) : await api.agent.rejectAction(action.id);
      setPendingActions((list) => list.map((a) => (a.id === action.id ? r.action : a)));
      if (decision === 'approve' && r.action.status === 'executed') toast.success('Approved and applied');
      if (decision === 'approve' && r.action.status === 'failed') toast.error('Approval recorded, but saving failed');
      if (decision === 'reject') toast.success('Rejected — nothing was changed');
      refreshSurfaces({ keepDecided: true });
    } catch (e) {
      toast.error(e.message || 'Could not record that decision');
    } finally {
      setDecidingId(null);
    }
  };

  const openConversation = async (id) => {
    try {
      const r = await api.agent.conversation(id);
      setActiveId(id);
      setMessages(r.messages || []);
      setActions([...(r.actions || [])].sort((a, b) => a.id - b.id));
      scrollDown();
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') { setDisabled(true); return; }
      toast.error('Could not open that conversation');
    }
  };

  // Deploy #89: the state reset was always correct — but on mobile the
  // brief + intake sections sit between this header button and the thread,
  // so the tap changed nothing on screen and read as broken. Now the tap
  // also brings the fresh thread into view and focuses the composer.
  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setActions([]);
    setInput('');
    setQuotaNotice(null);
    requestAnimationFrame(() => {
      const card = threadCardRef.current;
      if (card && typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (composerRef.current) composerRef.current.focus();
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setQuotaNotice(null);
    const tmpId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tmpId, role: 'user', content: text, tool_events: [] }]);
    scrollDown();
    try {
      const r = await api.agent.chat(activeId, text);
      setActiveId(r.convo_id);
      setMessages((m) => [...m, { id: `tmp-a-${Date.now()}`, role: 'assistant', content: r.reply, tool_events: r.tool_events || [] }]);
      if (r.actions && r.actions.length) {
        setActions((a) => [...a, ...r.actions]);
      }
      loadConversations().catch(() => {});
      // Chat-proposed cards also belong to the global approvals list.
      refreshSurfaces({ keepDecided: true });
      scrollDown();
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') { setDisabled(true); return; }
      if (e.status === 402 && e.limitInfo && e.limitInfo.error === 'ai_query_limit_reached') {
        // The quota gate fired BEFORE the turn ran — the server never
        // saved this message. Drop the optimistic bubble, restore the
        // words to the composer, and show the upgrade notice instead of
        // a raw error toast.
        setMessages((m) => m.filter((x) => x.id !== tmpId));
        setInput(text);
        setQuotaNotice(e.limitInfo);
        return;
      }
      toast.error(e.message || 'The agent could not answer — try again');
      // The server saved the user's message; resync the thread to show the
      // true state instead of a phantom reply.
      if (activeId) openConversation(activeId);
      else loadConversations().catch(() => {});
    } finally {
      setSending(false);
    }
  };

  const decide = async (action, decision) => {
    setDecidingId(action.id);
    try {
      const r = decision === 'approve' ? await api.agent.approveAction(action.id) : await api.agent.rejectAction(action.id);
      setActions((list) => list.map((a) => (a.id === action.id ? r.action : a)));
      if (decision === 'approve' && r.action.status === 'executed') toast.success('Approved and applied');
      if (decision === 'approve' && r.action.status === 'failed') toast.error('Approval recorded, but saving failed');
      if (decision === 'reject') toast.success('Rejected — nothing was changed');
      loadConversations().catch(() => {});
      refreshSurfaces({ keepDecided: true });
    } catch (e) {
      toast.error(e.message || 'Could not record that decision');
    } finally {
      setDecidingId(null);
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Agent" subtitle="Your RCM agent" />
        <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      </div>
    );
  }

  if (disabled) {
    return (
      <div>
        <PageHeader title="Agent" subtitle="Your RCM agent" />
        <div className="card">
          <EmptyState
            icon="🤖"
            title="The agent isn't enabled on this workspace yet"
            hint="The ClaimPaid agent will read your worklist, draft appeals, and line up the next action for your approval. It's being switched on for workspaces in stages — nothing for you to set up here."
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Agent"
        subtitle="Reads your queue, drafts the work, and never saves anything without your approval."
        actions={(
          <span className="flex gap-2">
            <button className="btn btn-outline" onClick={() => setShowAudit(true)}>⏰ Deadline audit</button>
            <button className="btn btn-dark" onClick={newChat}>+ New chat</button>
          </span>
        )}
      />
      {alerts && alerts.total > 0 && (
        <div className="motion-fade-slide mb-5 rounded-2xl border border-amber-300 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
          <button type="button" onClick={() => setAlertsOpen((o) => !o)} aria-expanded={alertsOpen}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 w-full text-left">
            <span className="font-semibold">⚡ Needs attention</span>
            {alerts.pending_approvals.count > 0 && <span>{alerts.pending_approvals.count} approval{alerts.pending_approvals.count === 1 ? '' : 's'} waiting on you</span>}
            {alerts.filing_risk.count > 0 && <span>${Number(alerts.filing_risk.amount).toLocaleString()} at filing risk ({alerts.filing_risk.count} claim{alerts.filing_risk.count === 1 ? '' : 's'})</span>}
            {alerts.followups_overdue.count > 0 && <span>{alerts.followups_overdue.count} follow-up{alerts.followups_overdue.count === 1 ? '' : 's'} overdue</span>}
            {alerts.era_exceptions.count > 0 && <span>{alerts.era_exceptions.count} ERA exception{alerts.era_exceptions.count === 1 ? '' : 's'} on hold</span>}
            {alerts.re_denied && alerts.re_denied.count > 0 && <span>{alerts.re_denied.count} appeal{alerts.re_denied.count === 1 ? '' : 's'} re-denied — ready to draft a response</span>}
            {alerts.payer_silent && alerts.payer_silent.count > 0 && <span>{alerts.payer_silent.count} payer{alerts.payer_silent.count === 1 ? '' : 's'} silent past the typical window</span>}
            <span className="ml-auto text-xs font-semibold underline underline-offset-2">{alertsOpen ? 'Hide details' : 'Show details'}</span>
          </button>
          {alertsOpen && (
            <div className="mt-3 border-t border-amber-200 pt-3 space-y-4">
              {alerts.pending_approvals.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">Approvals waiting</div>
                  <ul className="space-y-1">
                    {(alerts.pending_approvals.highlights || []).map((t, i) => (
                      <li key={i} className="text-[13px]">{t}</li>
                    ))}
                  </ul>
                  {alerts.pending_approvals.count > (alerts.pending_approvals.highlights || []).length && (
                    <div className="text-xs text-amber-800 mt-1">+ {alerts.pending_approvals.count - (alerts.pending_approvals.highlights || []).length} more below</div>
                  )}
                  <button type="button" className="btn btn-primary btn-sm mt-2" onClick={scrollToApprovals}>Review approvals ↓</button>
                </div>
              )}
              {alerts.filing_risk.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">Filing risk — deadline within 14 days</div>
                  <div className="space-y-1.5">
                    {(alerts.filing_risk.highlights || []).map((h) => (
                      <div key={h.claim_id || h.claim_number} className="flex items-center gap-2 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{h.claim_number}</span>
                          <span className="text-amber-800"> — {h.days_left < 0 ? `expired ${-h.days_left}d ago` : `${h.days_left}d left`} · ${Number(h.amount).toLocaleString()}</span>
                        </span>
                        <ClaimRowActions
                          claimId={h.claim_id != null ? h.claim_id : null}
                          denied={h.status === 'denied'}
                          pendingActions={pendingActions}
                          proposingId={proposingId}
                          onOpenClaim={onOpenClaim}
                          onProposeDraft={proposeDraft}
                          onScrollApprovals={scrollToApprovals}
                          onShowDetails={showClaimDetails}
                        />
                      </div>
                    ))}
                  </div>
                  {alerts.filing_risk.count > (alerts.filing_risk.highlights || []).length && (
                    <div className="text-xs text-amber-800 mt-1">+ {alerts.filing_risk.count - (alerts.filing_risk.highlights || []).length} more in My Work</div>
                  )}
                </div>
              )}
              {alerts.followups_overdue.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">Follow-ups overdue</div>
                  <div className="space-y-1.5">
                    {(alerts.followups_overdue.highlights || []).map((h) => (
                      <div key={h.appeal_id || h.claim_number} className="flex items-center gap-2 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{h.claim_number}</span>
                          <span className="text-amber-800"> — follow-up was due {h.due}</span>
                        </span>
                        <ClaimRowActions
                          claimId={h.claim_id != null ? h.claim_id : null}
                          denied={false}
                          pendingActions={pendingActions}
                          proposingId={proposingId}
                          onOpenClaim={onOpenClaim}
                          onProposeDraft={proposeDraft}
                          onScrollApprovals={scrollToApprovals}
                          onShowDetails={showClaimDetails}
                        />
                      </div>
                    ))}
                  </div>
                  {alerts.followups_overdue.count > (alerts.followups_overdue.highlights || []).length && (
                    <div className="text-xs text-amber-800 mt-1">+ {alerts.followups_overdue.count - (alerts.followups_overdue.highlights || []).length} more in My Work</div>
                  )}
                </div>
              )}
              {alerts.re_denied && alerts.re_denied.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">Appeals re-denied — ready to draft a response</div>
                  <div className="space-y-1.5">
                    {(alerts.re_denied.highlights || []).map((h) => (
                      <div key={h.appeal_id || h.claim_number} className="flex items-center gap-2 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{h.claim_number}</span>
                          <span className="text-amber-800"> — the payer denied again; the appeal is reopened</span>
                        </span>
                        <ClaimRowActions
                          claimId={h.claim_id != null ? h.claim_id : null}
                          denied
                          pendingActions={pendingActions}
                          proposingId={proposingId}
                          onOpenClaim={onOpenClaim}
                          onProposeDraft={proposeDraft}
                          onScrollApprovals={scrollToApprovals}
                          onShowDetails={showClaimDetails}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {alerts.payer_silent && alerts.payer_silent.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">Payer silent — past the typical response window</div>
                  <div className="space-y-1.5">
                    {(alerts.payer_silent.highlights || []).map((h) => (
                      <div key={h.appeal_id || h.claim_number} className="flex items-center gap-2 text-[13px]">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{h.claim_number}</span>
                          <span className="text-amber-800"> — {h.days_waiting} days waiting (typical window {h.response_days}) — open the claim for the call brief</span>
                        </span>
                        <ClaimRowActions
                          claimId={h.claim_id != null ? h.claim_id : null}
                          denied={false}
                          pendingActions={pendingActions}
                          proposingId={proposingId}
                          onOpenClaim={onOpenClaim}
                          onProposeDraft={proposeDraft}
                          onScrollApprovals={scrollToApprovals}
                          onShowDetails={showClaimDetails}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {alerts.era_exceptions.count > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 mb-1.5">ERA exceptions on hold</div>
                  <div className="space-y-1.5">
                    {(alerts.era_exceptions.highlights || []).map((h) => (
                      <div key={h.era_line_id} className="text-[13px]">
                        <span className="font-medium">{h.claim_number}</span>
                        <span className="text-amber-800"> — {fmtMoney2(h.amount)} billed on a held remittance line</span>
                      </div>
                    ))}
                  </div>
                  {onOpenEra && (
                    <button type="button" className="btn btn-outline btn-sm mt-2" onClick={onOpenEra}>Open ERA inbox →</button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <ApprovalsSection actions={pendingActions} decidingId={decidingId} onDecide={decidePending} onShowClaimDetails={showClaimDetails}
        selectedIds={selectedIds} onToggleSelect={toggleSelect} onSelectAll={selectAllPending}
        onBatchDecide={batchDecide} batchBusy={batchBusy} batchSummary={batchSummary} />
      <AutoApprovedSection actions={autoActions} onVoid={voidAuto} voidingId={voidingId}
        isOwner={isOwner} policy={policy} onSavePolicy={savePolicy} policyBusy={policyBusy} />
      {brief && (
        <BriefSection
          brief={brief}
          pendingActions={pendingActions}
          onOpenClaim={onOpenClaim}
          onProposeDraft={proposeDraft}
          proposingId={proposingId}
          onScrollApprovals={scrollToApprovals}
          onShowDetails={showClaimDetails}
        />
      )}
      <DocumentIntake ActionCard={ActionCard} />
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)] items-start">
        {/* Conversation list */}
        <div className="card p-3 lg:sticky lg:top-5">
          <div className="px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-widest text-stone-400">Conversations</div>
          {conversations.length === 0 && (
            <p className="px-2 pb-2 text-sm text-stone-400">No conversations yet — ask the agent something to start.</p>
          )}
          <div className="space-y-1 max-h-64 lg:max-h-[520px] overflow-auto">
            {conversations.map((c) => (
              <button key={c.id} onClick={() => openConversation(c.id)}
                className={`w-full text-left rounded-xl px-3 py-2.5 transition ${c.id === activeId ? 'bg-emerald-50 ring-1 ring-emerald-200' : 'hover:bg-stone-50'}`}>
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate text-sm font-medium text-stone-800">{c.title || 'Conversation'}</span>
                  {c.pending_actions > 0 && (
                    <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">{c.pending_actions}</span>
                  )}
                </div>
                <div className="text-[11px] text-stone-400 mt-0.5">{new Date(String(c.updated_at).replace(' ', 'T') + 'Z').toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Thread */}
        <div ref={threadCardRef} className="card flex flex-col overflow-hidden">
          <div ref={threadRef} className="flex-1 overflow-auto p-4 sm:p-5 space-y-4 max-h-[560px] min-h-[320px]">
            {messages.length === 0 && actions.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center py-10">
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 ring-1 ring-emerald-200 flex items-center justify-center text-2xl mb-4">🤖</div>
                <div className="font-display font-semibold text-stone-800 text-lg">What should we work on?</div>
                <p className="text-sm text-stone-500 mt-1 max-w-md">Ask about your queue, a claim, or a payer — or have the agent draft an appeal for a denied claim. Drafts always wait for your approval.</p>
                <div className="flex flex-wrap gap-2 mt-5 justify-center">
                  {['What should I work on first today?', 'Which claims are closest to their filing deadline?', 'What are my unworked denials worth?'].map((q) => (
                    <button key={q} className="btn btn-outline btn-sm" onClick={() => setInput(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${m.role === 'user' ? 'bg-[#17251F] text-white rounded-br-md' : 'bg-stone-50 border border-stone-200 text-stone-800 rounded-bl-md'}`}>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>
                  {m.role === 'assistant' && <ToolChips events={m.tool_events} />}
                </div>
              </div>
            ))}
            {actions.map((a) => (
              <ActionCard key={a.id} action={a} busy={decidingId === a.id} onDecide={decide} onShowClaimDetails={showClaimDetails} />
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-stone-50 border border-stone-200 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-stone-400">
                  <span className="motion-chip-pulse inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 px-2.5 py-1 text-xs font-medium">
                    <span className="text-emerald-600">{TOOL_ICON}</span>Working on it…
                  </span>
                </div>
              </div>
            )}
          </div>
          {quotaNotice && (
            <div className="border-t border-amber-300 bg-amber-50 px-4 py-3 sm:px-5">
              <div className="text-sm font-semibold text-amber-900">
                You've used this month's {Number(quotaNotice.limit).toLocaleString()} AI uses on {quotaNotice.planLabel || 'your plan'}
              </div>
              <p className="text-[13px] text-amber-800 mt-0.5">
                {quotaNotice.message || 'The agent pauses here until the quota resets on the 1st — or an upgrade raises it.'}{' '}
                <button onClick={goBilling} className="font-semibold text-emerald-800 underline hover:text-emerald-950">
                  See plans &amp; upgrade →
                </button>
              </p>
            </div>
          )}
          <div className="border-t border-stone-200 p-3 sm:p-4 bg-[#FFFDF8]">
            <div className="flex gap-2 items-end">
              <textarea
                ref={composerRef}
                className="input flex-1 resize-none"
                rows={2}
                placeholder="Ask the agent — e.g. “Draft an appeal for claim HV-1013”"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <button className="btn btn-primary" disabled={sending || !input.trim()} onClick={send}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
            <p className="text-[11px] text-stone-400 mt-2">The agent works only from your workspace data. Drafts are proposals — they save only when you approve them, and are never submitted to a payer automatically.</p>
          </div>
        </div>
      </div>
      <TeamSection onShowDetails={showClaimDetails} />
      {showAudit && <AuditRunner onClose={() => setShowAudit(false)} />}
      {detailsClaimId && (
        <ClaimDetailsModal claimId={detailsClaimId} onClose={() => setDetailsClaimId(null)} />
      )}
    </div>
  );
}
