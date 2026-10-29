import { useEffect, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney2, fmtDate } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';
import ClaimDetailsModal from '../components/ClaimDetailsModal';

const SUBMIT_VIA = {
  payer_portal: 'Payer portal', fax: 'Fax', mail: 'Mail', clearinghouse: 'Clearinghouse',
};

const STATUS_META = {
  open: { label: 'Open', badge: 'badge-slate' },
  in_progress: { label: 'In Progress', badge: 'badge-blue' },
  submitted: { label: 'Submitted', badge: 'badge-amber' },
  won: { label: 'Won', badge: 'badge-green' },
  lost: { label: 'Lost', badge: 'badge-rose' },
};

const PRIORITY_META = {
  urgent: { label: 'Urgent', badge: 'badge-rose' },
  high: { label: 'High', badge: 'badge-amber' },
  medium: { label: 'Medium', badge: 'badge-blue' },
  low: { label: 'Low', badge: 'badge-slate' },
};

function AppealDrawer({ appealId, onClose, onChanged, team, onShowDetails }) {
  const { user } = useAuth();
  const toast = useToast();
  const [appeal, setAppeal] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [authMatches, setAuthMatches] = useState(null);
  const [showAuths, setShowAuths] = useState(false);
  const [letter, setLetter] = useState(null);
  const [letterBusy, setLetterBusy] = useState(false);
  // Deploy #98: the SAVED letter (appeals.letter) — editor + submit form.
  const [editingLetter, setEditingLetter] = useState(false);
  const [letterText, setLetterText] = useState('');
  const [letterSaving, setLetterSaving] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [submitVia, setSubmitVia] = useState('payer_portal');
  const [submitFollowUp, setSubmitFollowUp] = useState('');
  const [submitBusy, setSubmitBusy] = useState(false);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  useEffect(() => { setEditingLetter(false); setShowSubmit(false); }, [appealId]);

  const load = () => authFetch(`/api/appeals/${appealId}`).then((r) => r.json()).then(setAppeal);
  useEffect(() => { load(); }, [appealId]);
  useEffect(() => {
    if (appeal?.claim_id) {
      api.authzFindForClaim(appeal.claim_id).then(setAuthMatches).catch(() => setAuthMatches({ matches: [] }));
    }
  }, [appeal?.claim_id]);

  const update = async (fields) => {
    setSaving(true);
    try {
      const res = await authFetch(`/api/appeals/${appealId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setAppeal(await res.json());
      toast.success('Appeal updated');
      onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      const res = await authFetch(`/api/appeals/${appealId}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: noteText }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNoteText('');
      load(); onChanged();
      toast.success('Note added');
    } catch (e) { toast.error(e.message); }
  };

  const generateLetter = async () => {
    setLetterBusy(true);
    try {
      const res = await authFetch(`/api/appeals/${appealId}/letter`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setLetter(data);
    } catch (e) { toast.error(e.message); }
    finally { setLetterBusy(false); }
  };

  // Deploy #98: saved-letter actions — edit in place, print the document,
  // and record the real-world submission (channel + follow-up).
  const saveLetter = async () => {
    setLetterSaving(true);
    try {
      const res = await authFetch(`/api/appeals/${appealId}/letter`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ letter: letterText }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setAppeal(await res.json());
      setEditingLetter(false);
      toast.success('Letter saved');
      onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setLetterSaving(false); }
  };

  const printSavedLetter = () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Appeal letter — ${appeal.claim_number}</title><style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 24px;line-height:1.7;white-space:pre-wrap}</style></head><body>${(appeal.letter || '').replace(/</g, '&lt;')}</body></html>`);
    w.document.close(); w.print();
  };

  const openSubmitForm = () => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    setSubmitFollowUp(d.toISOString().slice(0, 10));
    setShowSubmit(true);
  };

  const markSubmitted = async () => {
    setSubmitBusy(true);
    try {
      const res = await authFetch(`/api/appeals/${appealId}/mark-submitted`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ via: submitVia, follow_up_date: submitFollowUp || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setAppeal(await res.json());
      setShowSubmit(false);
      toast.success(`Marked submitted via ${SUBMIT_VIA[submitVia]} — follow-up set`);
      onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setSubmitBusy(false); }
  };

  if (!appeal) return <Modal onClose={onClose}><div className="p-8"><Skeleton className="h-64" /></div></Modal>;

  const sm = STATUS_META[appeal.status];

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="text-xs font-mono text-stone-400">{appeal.claim_number}</div>
            <h3 className="text-xl font-bold tracking-tight">{appeal.patient_name}</h3>
            <div className="text-sm text-stone-500 mt-0.5">{appeal.payer} · {fmtDate(appeal.service_date)} · {appeal.denial_reason}</div>
          </div>
          <button onClick={onClose} className="btn-ghost btn !px-2.5">✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3 mb-6">
          <span className={`badge ${sm.badge}`}>{sm.label}</span>
          <span className={`badge ${PRIORITY_META[appeal.priority].badge}`}>{PRIORITY_META[appeal.priority].label} priority</span>
          <span className="badge badge-slate">{fmtMoney2(appeal.billed_amount - appeal.paid_amount)} at stake</span>
          <button onClick={generateLetter} disabled={letterBusy}
            className="btn btn-outline !py-1.5 !text-xs !ml-auto">
            {letterBusy ? 'Drafting…' : '✉️ Generate appeal letter'}
          </button>
          {onShowDetails && appeal.claim_id && (
            <button onClick={() => onShowDetails(appeal.claim_id)}
              className="btn btn-outline !py-1.5 !text-xs">
              Claim details
            </button>
          )}
        </div>

        {/* Deploy #98: the SAVED letter — a document with its own actions,
            not a comment in the notes timeline. */}
        {appeal.letter && (
          <div className="mb-6 border border-stone-200 rounded-2xl overflow-hidden">
            <div className="bg-stone-900 text-white px-5 py-3 flex flex-wrap items-center gap-2">
              <div>
                <div className="font-semibold text-sm">Appeal letter</div>
                <div className="text-[11px] text-stone-400">
                  {appeal.status === 'submitted' && appeal.submitted_via
                    ? `Submitted via ${SUBMIT_VIA[appeal.submitted_via] || appeal.submitted_via}${appeal.submitted_at ? ` · ${new Date(String(appeal.submitted_at).replace(' ', 'T') + 'Z').toLocaleDateString()}` : ''}`
                    : 'Saved on this appeal — edit it, print it, then mark it submitted once it has been sent'}
                </div>
              </div>
              {appeal.status === 'open' && <span className="badge badge-amber">Appeal drafted — not submitted</span>}
              <div className="flex gap-2 ml-auto">
                {editingLetter ? (
                  <>
                    <button onClick={saveLetter} disabled={letterSaving || !letterText.trim()}
                      className="btn !bg-emerald-500 hover:!bg-emerald-600 !text-white !py-1.5 !text-xs">
                      {letterSaving ? 'Saving…' : 'Save letter'}
                    </button>
                    <button onClick={() => setEditingLetter(false)}
                      className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">Cancel</button>
                  </>
                ) : (
                  <>
                    {canWrite && (
                      <button onClick={() => { setLetterText(appeal.letter); setEditingLetter(true); }}
                        className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">Edit letter</button>
                    )}
                    <button onClick={printSavedLetter}
                      className="btn !bg-emerald-500 hover:!bg-emerald-600 !text-white !py-1.5 !text-xs">Print letter</button>
                    {canWrite && appeal.status !== 'submitted' && (
                      <button onClick={() => (showSubmit ? setShowSubmit(false) : openSubmitForm())}
                        className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">Mark as submitted</button>
                    )}
                  </>
                )}
              </div>
            </div>
            {editingLetter ? (
              <div className="bg-white px-5 py-4">
                <textarea className="input font-serif !text-[13px] leading-relaxed" rows={16}
                  value={letterText} onChange={(e) => setLetterText(e.target.value)} />
                <div className="text-[11px] text-stone-400 mt-2">Saving replaces the letter on this appeal. The previous text is not kept — copy it first if you need it.</div>
              </div>
            ) : (
              <div className="bg-white px-6 py-5 max-h-[320px] overflow-y-auto">
                <pre className="whitespace-pre-wrap font-serif text-[13px] leading-relaxed text-stone-700">{appeal.letter}</pre>
              </div>
            )}
            {showSubmit && !editingLetter && (
              <div className="bg-[#FAF5EB] border-t border-stone-200 px-5 py-4 flex flex-wrap items-end gap-3">
                <div>
                  <label className="label">Sent via</label>
                  <select className="input !w-auto" value={submitVia} onChange={(e) => setSubmitVia(e.target.value)}>
                    {Object.entries(SUBMIT_VIA).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Follow up on</label>
                  <input type="date" className="input !w-auto" value={submitFollowUp} onChange={(e) => setSubmitFollowUp(e.target.value)} />
                </div>
                <button className="btn btn-primary !py-2" disabled={submitBusy} onClick={markSubmitted}>
                  {submitBusy ? 'Recording…' : 'Record submission'}
                </button>
                <span className="text-xs text-stone-500">ClaimPaid doesn't transmit the appeal — this records how you sent it and puts the follow-up in the queue.</span>
              </div>
            )}
          </div>
        )}

        {letter && (
          <div className="mb-6 border border-stone-200 rounded-2xl overflow-hidden">
            <div className="bg-stone-900 text-white px-5 py-3 flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm">{letter.subject}</div>
                <div className="text-[11px] text-stone-400">Auto-drafted from denial reason · review before sending</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { navigator.clipboard.writeText(letter.text); toast.success('Letter copied to clipboard'); }}
                  className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">Copy</button>
                <button onClick={() => {
                  const w = window.open('', '_blank');
                  w.document.write(`<html><head><title>${letter.subject}</title><style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:0 24px;line-height:1.7;white-space:pre-wrap}</style></head><body>${letter.text.replace(/</g, '&lt;')}</body></html>`);
                  w.document.close(); w.print();
                }} className="btn !bg-emerald-500 hover:!bg-emerald-600 !text-white !py-1.5 !text-xs">Print</button>
                <button onClick={() => setLetter(null)} className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">✕</button>
              </div>
            </div>
            <div className="bg-white px-6 py-5 max-h-[320px] overflow-y-auto">
              <pre className="whitespace-pre-wrap font-serif text-[13px] leading-relaxed text-stone-700">{letter.text}</pre>
            </div>
          </div>
        )}

        {/* Related prior authorization — the cross-link */}
        {appeal.linked_auths && appeal.linked_auths.length > 0 && (
          <div className="mb-6">
            <div className="text-sm font-semibold text-stone-700 mb-2">✅ Linked authorizations ({appeal.linked_auths.length})</div>
            <div className="space-y-2">
              {appeal.linked_auths.map((a) => (
                <div key={a.id} className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm">
                  <div>
                    <span className="font-semibold text-stone-900">Auth #{a.id}</span>
                    <span className="text-stone-500"> · {a.cpt_codes || '—'} · {a.auth_number || 'no auth #'}</span>
                    <div className="text-xs text-stone-400 mt-0.5 capitalize">{a.status.replace('_', ' ')}{a.payer ? ` · ${a.payer}` : ''}</div>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        const res = await authFetch(`/api/authz/${a.id}`, {
                          method: 'PUT', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ linked_claim_id: null }),
                        });
                        if (!res.ok) throw new Error((await res.json()).error);
                        toast.success(`Auth #${a.id} unlinked`);
                        load(); onChanged();
                      } catch (e) { toast.error(e.message); }
                    }}
                    className="btn btn-ghost !py-1.5 !text-xs shrink-0 !text-rose-600">
                    Unlink
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {authMatches && authMatches.matches.length > 0 && (
          <div className="mb-6">
            <button onClick={() => setShowAuths(!showAuths)}
              className="w-full flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 hover:bg-amber-100/70 transition">
              <span className="text-sm font-semibold text-amber-900">
                🔗 {authMatches.matches.length} related authorization{authMatches.matches.length === 1 ? '' : 's'} found
                <span className="font-normal text-amber-700"> — same patient or payer</span>
              </span>
              <span className="text-amber-700 text-lg">{showAuths ? '−' : '+'}</span>
            </button>
            {showAuths && (
              <div className="mt-2 space-y-2">
                {authMatches.matches.map((a) => (
                  <div key={a.id} className="flex items-center justify-between bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm">
                    <div>
                      <span className="font-semibold text-stone-900">Auth #{a.id}</span>
                      <span className="text-stone-500"> · {a.cpt_codes || '—'} · {a.auth_number || 'no auth #'}</span>
                      <div className="text-xs text-stone-400 mt-0.5">
                        {a.effective_status === 'expired' ? 'Expired' : a.effective_status === 'approved' ? `Valid through ${a.valid_to}` : a.effective_status.replace('_', ' ')}
                        {a.patient_name === appeal.patient_name
                          ? <span className="ml-1.5 badge badge-violet !text-[10px]">Same patient</span>
                          : <span className="ml-1.5 badge badge-slate !text-[10px]">Same payer</span>}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        try {
                          const res = await authFetch(`/api/authz/${a.id}`, {
                            method: 'PUT', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ linked_claim_id: appeal.claim_id }),
                          });
                          if (!res.ok) throw new Error((await res.json()).error);
                          toast.success(`Auth #${a.id} linked to this claim`);
                          setShowAuths(false);
                          load(); onChanged();
                        } catch (e) { toast.error(e.message); }
                      }}
                      className="btn btn-outline !py-1.5 !text-xs shrink-0">
                      Link to claim
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="grid sm:grid-cols-4 gap-3 mb-6">
          <div>
            <label className="label">Status</label>
            <select className="input" value={appeal.status} disabled={saving}
              onChange={(e) => update({ status: e.target.value })}>
              {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Assigned to</label>
            <select className="input" value={appeal.assigned_to || ''} disabled={saving}
              onChange={(e) => update({ assigned_to: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Unassigned</option>
              {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input" value={appeal.priority} disabled={saving}
              onChange={(e) => update({ priority: e.target.value })}>
              {Object.entries(PRIORITY_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Follow-up</label>
            <input type="date" className="input" value={appeal.follow_up_date || ''} disabled={saving}
              onChange={(e) => update({ follow_up_date: e.target.value || null })} />
          </div>
        </div>

        <div className="text-sm font-semibold text-stone-700 mb-3">Activity timeline</div>
        <div className="space-y-3 mb-5 max-h-[280px] overflow-y-auto pr-1">
          {appeal.notes.length === 0 && <div className="text-sm text-stone-400">No notes yet — document your first action below.</div>}
          {appeal.notes.map((n) => (
            <div key={n.id} className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-xs font-bold text-stone-500 shrink-0">
                {n.author.split(' ').map((w) => w[0]).join('').slice(0, 2)}
              </div>
              <div className="flex-1 bg-stone-50 rounded-xl px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-stone-700">{n.author}</span>
                  <span className="text-[11px] text-stone-400">{new Date(n.created_at).toLocaleString()}</span>
                </div>
                <div className="text-sm text-stone-700">{n.note}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {[
            ['📞 Called payer', 'Called payer — spoke with rep [name], ref #[]. '],
            ['📠 Faxed records', 'Faxed clinical records to payer. Confirmation received. '],
            ['💻 Portal message', 'Sent message via payer portal. Awaiting response. '],
            ['👥 Peer-to-peer', 'Peer-to-peer review requested with medical director. '],
          ].map(([label, text]) => (
            <button key={label} onClick={() => setNoteText((t) => t + text)}
              className="text-[11px] font-medium bg-stone-100 hover:bg-stone-200 text-stone-600 rounded-lg px-2.5 py-1.5 transition">
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="input" value={noteText} onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note — call outcome, fax confirmation, next step…"
            onKeyDown={(e) => e.key === 'Enter' && addNote()} />
          <button className="btn btn-primary shrink-0" onClick={addNote}>Add note</button>
        </div>
      </div>
    </Modal>
  );
}

function StartAppealModal({ denials, preselectClaimId, onClose, onStarted, team, onShowDetails }) {
  const toast = useToast();
  const [selected, setSelected] = useState(
    preselectClaimId ? denials.find((d) => d.claim_id === preselectClaimId) || null : null
  );
  const [priority, setPriority] = useState('medium');
  const [assignee, setAssignee] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!selected) { toast.error('Select a denied claim first'); return; }
    setBusy(true);
    try {
      const res = await authFetch('/api/appeals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claim_id: selected.claim_id, priority,
          assigned_to: assignee ? Number(assignee) : null,
          follow_up_date: followUp || null, note: note || null,
        }),
      });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error); }
      toast.success('Appeal opened');
      onStarted();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Open a new appeal</h3>
        <p className="text-sm text-stone-500 mb-5">Denied claims without an appeal yet, sorted by dollars at stake.</p>
        <div className="max-h-[300px] overflow-y-auto border border-stone-200 rounded-xl mb-5">
          <table className="w-full text-sm tbl">
            <thead className="sticky top-0"><tr><th></th><th>Claim #</th><th>Patient</th><th>Payer</th><th>Reason</th><th className="!text-right">At stake</th></tr></thead>
            <tbody>
              {denials.map((d) => (
                <tr key={d.claim_id} onClick={() => setSelected(d)}
                  className={`cursor-pointer ${selected?.claim_id === d.claim_id ? '!bg-emerald-50' : ''}`}>
                  <td><input type="radio" checked={selected?.claim_id === d.claim_id} onChange={() => setSelected(d)} /></td>
                  <td className="font-mono text-xs">{d.claim_number}
                    {onShowDetails && (
                      <button className="ml-2 font-sans text-[11px] font-semibold text-emerald-700 hover:underline"
                        onClick={(e) => { e.stopPropagation(); onShowDetails(d.claim_id); }}>
                        Details
                      </button>
                    )}
                  </td>
                  <td>{d.patient_name}</td>
                  <td>{d.payer}</td>
                  <td className="text-xs text-stone-500">{d.denial_reason}</td>
                  <td className="!text-right font-semibold">{fmtMoney2(d.at_stake)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {denials.length === 0 && <div className="p-6 text-center text-sm text-stone-400">Every denied claim already has an appeal. Nice work.</div>}
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mb-4">
          <div><label className="label">Priority</label>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {Object.entries(PRIORITY_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select></div>
          <div><label className="label">Assign to</label>
            <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></div>
          <div><label className="label">Follow-up date</label>
            <input type="date" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></div>
        </div>
        <div className="mb-5"><label className="label">Opening note</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why was it denied? First action…" /></div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !selected} onClick={start}>{busy ? 'Opening…' : 'Open appeal'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Denials({ initialAppealId, initialStartAppealClaimId, onConsumed }) {
  const { user } = useAuth();
  const toast = useToast();
  const [appeals, setAppeals] = useState(null);
  const [unworked, setUnworked] = useState([]);
  const [team, setTeam] = useState([]);
  const [tab, setTab] = useState('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [drawerId, setDrawerId] = useState(null);
  const [showStart, setShowStart] = useState(false);
  const [preselectClaimId, setPreselectClaimId] = useState(null);
  const [detailsClaimId, setDetailsClaimId] = useState(null);

  useEffect(() => {
    if (initialAppealId) { setDrawerId(initialAppealId); onConsumed?.(); }
    if (initialStartAppealClaimId) {
      setPreselectClaimId(initialStartAppealClaimId);
      setShowStart(true);
      onConsumed?.();
    }
  }, []);

  const load = () => {
    const params = {};
    if (tab === 'mine') params.assignee = 'me';
    if (tab === 'unassigned') params.assignee = 'unassigned';
    if (tab === 'closed') params.status = '';
    if (statusFilter) params.status = statusFilter;
    api.appeals(params).then((rows) => {
      setAppeals(tab === 'closed' ? rows.filter((r) => ['won', 'lost'].includes(r.status)) : rows.filter((r) => !['won', 'lost'].includes(r.status)));
    });
    api.unworkedDenials().then(setUnworked);
    api.team().then(setTeam).catch(() => {});
  };
  useEffect(() => { load(); }, [tab, statusFilter]);
  useEffect(() => { if (drawerId) { /* refresh on drawer change handled by onChanged */ } }, [drawerId]);

  const canWrite = ['owner', 'biller'].includes(user?.role);

  const tabs = [
    { id: 'all', label: 'Open queue' },
    { id: 'mine', label: 'Assigned to me' },
    { id: 'unassigned', label: 'Unassigned' },
    { id: 'closed', label: 'Closed' },
  ];

  return (
    <div>
      {drawerId && <AppealDrawer appealId={drawerId} onClose={() => setDrawerId(null)} onChanged={load} team={team} onShowDetails={setDetailsClaimId} />}
      {showStart && <StartAppealModal denials={unworked} preselectClaimId={preselectClaimId} onClose={() => { setShowStart(false); setPreselectClaimId(null); }} onStarted={() => { setShowStart(false); setPreselectClaimId(null); setTab('all'); load(); }} team={team} onShowDetails={setDetailsClaimId} />}
      {detailsClaimId && <ClaimDetailsModal claimId={detailsClaimId} onClose={() => setDetailsClaimId(null)} />}

      <PageHeader
        title="Denial Appeals"
        subtitle="Work every denial like a pipeline — assign, track, win."
        actions={canWrite ? [
          <button key="start" className="btn btn-primary" onClick={() => setShowStart(true)}>+ Open appeal</button>,
        ] : []}
      />

      <div className="flex flex-wrap items-center gap-2 mb-5">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${tab === t.id ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'}`}>
            {t.label}
          </button>
        ))}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="ml-auto input !w-auto">
          <option value="">All statuses</option>
          {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </select>
      </div>

      {!appeals ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : appeals.length === 0 ? (
        <div className="card">
          <EmptyState icon="🎉" title="Queue is clear"
            hint={tab === 'closed' ? 'No closed appeals yet.' : 'No appeals match. Open one from an unworked denial to get started.'}
            action={canWrite && unworked.length > 0 ? <button className="btn btn-primary" onClick={() => setShowStart(true)}>+ Open appeal</button> : null} />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr>
                <th>Claim</th><th>Patient</th><th>Denial reason</th><th className="!text-right">At stake</th>
                <th>Priority</th><th>Assignee</th><th>Follow-up</th><th>Status</th>
              </tr></thead>
              <tbody>
                {appeals.map((a) => {
                  const overdue = a.follow_up_date && a.follow_up_date < new Date().toISOString().slice(0, 10) && !['won', 'lost'].includes(a.status);
                  return (
                    <tr key={a.id} onClick={() => setDrawerId(a.id)} className="cursor-pointer">
                      <td className="font-mono text-xs">{a.claim_number}</td>
                      <td className="font-medium">{a.patient_name}<div className="text-xs text-stone-400 font-normal">{a.payer}</div></td>
                      <td className="text-xs text-stone-500 max-w-[220px]">{a.denial_reason}</td>
                      <td className="!text-right font-semibold">{fmtMoney2(a.at_stake)}</td>
                      <td><span className={`badge ${PRIORITY_META[a.priority].badge}`}>{PRIORITY_META[a.priority].label}</span></td>
                      <td className="text-xs">{a.assignee_name || <span className="text-stone-400">Unassigned</span>}</td>
                      <td className={`text-xs ${overdue ? 'text-rose-600 font-semibold' : 'text-stone-500'}`}>
                        {a.follow_up_date ? fmtDate(a.follow_up_date) : '—'}{overdue ? ' ⚠' : ''}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_META[a.status].badge}`}>{STATUS_META[a.status].label}</span>
                        {!!a.has_letter && a.status === 'open' && <div className="text-[11px] text-amber-700 font-medium mt-1">📝 Drafted — not submitted</div>}
                        {a.status === 'submitted' && a.submitted_via && <div className="text-[11px] text-stone-400 mt-1">via {SUBMIT_VIA[a.submitted_via] || a.submitted_via}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unworked.length > 0 && tab === 'all' && (
        <div className="mt-4 text-sm text-stone-500">
          <strong className="text-stone-700">{unworked.length}</strong> denied claims have no appeal yet
          ({fmtMoney2(unworked.reduce((s, d) => s + d.at_stake, 0))} at stake).
          {canWrite && <button onClick={() => setShowStart(true)} className="ml-2 text-emerald-600 font-semibold hover:underline">Start working them →</button>}
        </div>
      )}
    </div>
  );
}
