import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import { PageHeader, EmptyState, Skeleton, useToast } from '../components/ui';

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
    executedNote: (a) => (a.result?.appeal_id ? 'Saved as a draft appeal on the claim — find it in Denial Appeals.' : null),
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
};

function ActionCard({ action, busy, onDecide }) {
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
        <span className="text-sm font-bold text-stone-900">{action.title}</span>
        <span className={`badge ${meta.pill}`}>{meta.label}</span>
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
    </div>
  );
}

function BriefSection({ brief, actions, decidingId, onDecide }) {
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
  // Queue clear (Phase 4): the brief proposed drafts and none are left
  // pending — the server only returns pending cards, so an empty list
  // alongside non-empty proposed ids means every one was decided.
  const proposedIds = brief.proposed_draft_action_ids || [];
  const queueClear = proposedIds.length > 0 && !actions.some((a) => a.status === 'pending');
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
      {brief.plan && brief.plan.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Today's plan</div>
          <ol className="space-y-1.5">
            {brief.plan.map((p, i) => (
              <li key={p.key || p.rank} className="motion-fade-slide flex items-baseline gap-2.5 text-sm" style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
                <span className="font-display font-semibold text-emerald-700 w-5 shrink-0">{p.rank}.</span>
                <span className="min-w-0">
                  <span className="font-medium text-stone-800">{p.title}</span>
                  {p.reason && <span className="text-stone-500"> — {p.reason}</span>}
                </span>
                {p.amount != null && <span className="ml-auto shrink-0 font-medium text-stone-700">${Number(p.amount).toLocaleString()}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Drafts ready for your approval</div>
          <div className="space-y-3">
            {actions.map((a) => (
              <ActionCard key={a.id} action={a} busy={decidingId === a.id} onDecide={onDecide} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Agent() {
  const toast = useToast();
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState(null);
  const [briefActions, setBriefActions] = useState([]);
  const [alerts, setAlerts] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [actions, setActions] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [decidingId, setDecidingId] = useState(null);
  const threadRef = useRef(null);

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

  // Morning brief: generated lazily server-side on the first read of the
  // org-local day. A failure (other than the disabled state) just hides
  // the section — the chat below is unaffected.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.agent.brief();
        setBrief(r.brief || null);
        setBriefActions(r.actions || []);
      } catch (e) {
        if (e.code === 'AGENT_DISABLED') setDisabled(true);
      }
    })();
  }, []);

  // Watchdog alerts strip (Phase 4): the same items the morning digest
  // email carries, computed for this user. Silent on any failure.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.agent.alerts();
        setAlerts(r.items || null);
      } catch { /* strip just stays hidden */ }
    })();
  }, []);

  const decideBrief = async (action, decision) => {
    setDecidingId(action.id);
    try {
      const r = decision === 'approve' ? await api.agent.approveAction(action.id) : await api.agent.rejectAction(action.id);
      setBriefActions((list) => list.map((a) => (a.id === action.id ? r.action : a)));
      if (decision === 'approve' && r.action.status === 'executed') toast.success('Approved and applied');
      if (decision === 'approve' && r.action.status === 'failed') toast.error('Approval recorded, but saving failed');
      if (decision === 'reject') toast.success('Rejected — nothing was changed');
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

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setActions([]);
    setInput('');
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', content: text, tool_events: [] }]);
    scrollDown();
    try {
      const r = await api.agent.chat(activeId, text);
      setActiveId(r.convo_id);
      setMessages((m) => [...m, { id: `tmp-a-${Date.now()}`, role: 'assistant', content: r.reply, tool_events: r.tool_events || [] }]);
      if (r.actions && r.actions.length) {
        setActions((a) => [...a, ...r.actions]);
      }
      loadConversations().catch(() => {});
      scrollDown();
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') { setDisabled(true); return; }
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
        actions={<button className="btn btn-dark" onClick={newChat}>+ New chat</button>}
      />
      {alerts && alerts.total > 0 && (
        <div className="motion-fade-slide mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-amber-300 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">⚡ Needs attention</span>
          {alerts.pending_approvals.count > 0 && <span>{alerts.pending_approvals.count} approval{alerts.pending_approvals.count === 1 ? '' : 's'} waiting on you</span>}
          {alerts.filing_risk.count > 0 && <span>${Number(alerts.filing_risk.amount).toLocaleString()} at filing risk ({alerts.filing_risk.count} claim{alerts.filing_risk.count === 1 ? '' : 's'})</span>}
          {alerts.followups_overdue.count > 0 && <span>{alerts.followups_overdue.count} follow-up{alerts.followups_overdue.count === 1 ? '' : 's'} overdue</span>}
          {alerts.era_exceptions.count > 0 && <span>{alerts.era_exceptions.count} ERA exception{alerts.era_exceptions.count === 1 ? '' : 's'} on hold</span>}
        </div>
      )}
      {brief && <BriefSection brief={brief} actions={briefActions} decidingId={decidingId} onDecide={decideBrief} />}
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
        <div className="card flex flex-col overflow-hidden">
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
              <ActionCard key={a.id} action={a} busy={decidingId === a.id} onDecide={decide} />
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
          <div className="border-t border-stone-200 p-3 sm:p-4 bg-[#FFFDF8]">
            <div className="flex gap-2 items-end">
              <textarea
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
    </div>
  );
}
