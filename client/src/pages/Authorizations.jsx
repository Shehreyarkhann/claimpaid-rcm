import { useEffect, useState, useRef } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney } from '../api';
import { PageHeader, Skeleton, EmptyState, Modal, Badge } from '../components/ui';
import { useToast } from '../components/ui';

const STATUS_META = {
  draft: { label: 'Draft', cls: 'badge-slate' },
  submitted: { label: 'Submitted', cls: 'badge-blue' },
  pending_info: { label: 'Info Needed', cls: 'badge-amber' },
  approved: { label: 'Approved', cls: 'badge-green' },
  denied: { label: 'Denied', cls: 'badge-rose' },
  expired: { label: 'Expired', cls: 'badge-rose' },
  cancelled: { label: 'Cancelled', cls: 'badge-slate' },
};

const TRANSITIONS = {
  draft: ['submitted', 'cancelled'],
  submitted: ['pending_info', 'approved', 'denied', 'cancelled'],
  pending_info: ['submitted', 'approved', 'denied', 'cancelled'],
  approved: ['expired', 'cancelled'],
  denied: ['submitted', 'cancelled'],
  expired: ['submitted', 'cancelled'],
  cancelled: ['draft'],
};

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft;
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function ExpiryBadge({ auth }) {
  const st = auth.effective_status;
  if (st === 'expired' || (auth.status === 'approved' && auth.days_to_expiry !== null && auth.days_to_expiry < 0)) {
    return <span className="badge badge-rose">Expired</span>;
  }
  if (auth.status === 'approved' && auth.days_to_expiry !== null) {
    const d = auth.days_to_expiry;
    const cls = d <= 7 ? 'badge-rose' : d <= 14 ? 'badge-amber' : 'badge-slate';
    return <span className={`badge ${cls}`}>{d}d left</span>;
  }
  if ((auth.status === 'submitted' || auth.status === 'pending_info') && auth.days_waiting !== null) {
    const d = auth.days_waiting;
    const cls = d > 10 ? 'badge-amber' : 'badge-slate';
    return <span className={`badge ${cls}`}>{d}d waiting</span>;
  }
  return <span className="text-stone-300">—</span>;
}

// ---------------- New / Edit modal ----------------
const EMPTY = {
  patient_name: '', payer_id: '', provider: '', cpt_codes: '', icd_codes: '',
  units_requested: 1, service_date: '', needed_by_date: '', notes: '', assigned_to: '',
};

function AuthModal({ auth, payers, team, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(auth ? {
    patient_name: auth.patient_name, payer_id: auth.payer_id || '', provider: auth.provider || '',
    cpt_codes: auth.cpt_codes || '', icd_codes: auth.icd_codes || '',
    units_requested: auth.units_requested || 1, service_date: auth.service_date || '',
    needed_by_date: auth.needed_by_date || '', notes: auth.notes || '',
    assigned_to: auth.assigned_to || '',
  } : { ...EMPTY });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setError(null); setSaving(true);
    try {
      const payload = {
        ...form,
        payer_id: form.payer_id ? Number(form.payer_id) : null,
        assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        units_requested: Number(form.units_requested) || 1,
      };
      Object.keys(payload).forEach((k) => { if (payload[k] === '') payload[k] = null; });
      const res = await authFetch(auth ? `/api/authz/${auth.id}` : '/api/authz', {
        method: auth ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(auth ? 'Authorization updated' : 'Authorization created');
      onSaved(data.id || auth?.id);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">{auth ? 'Edit authorization' : 'New prior authorization'}</h3>
        <p className="text-sm text-stone-500 mb-5">{auth ? `Auth #${auth.id}` : 'Start tracking a new auth request'}</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className="label">Patient name *</label>
            <input className="input" value={form.patient_name} onChange={set('patient_name')} placeholder="Jane Doe" /></div>
          <div><label className="label">Payer</label>
            <select className="input" value={form.payer_id} onChange={set('payer_id')}>
              <option value="">Select payer…</option>
              {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
          <div><label className="label">Provider / facility</label>
            <input className="input" value={form.provider} onChange={set('provider')} placeholder="Dr. Smith — Orthopedics" /></div>
          <div><label className="label">Assign to</label>
            <select className="input" value={form.assigned_to} onChange={set('assigned_to')}>
              <option value="">Unassigned</option>
              {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          <div><label className="label">CPT codes</label>
            <input className="input font-mono" value={form.cpt_codes} onChange={set('cpt_codes')} placeholder="97110, 97140" /></div>
          <div><label className="label">ICD codes</label>
            <input className="input font-mono" value={form.icd_codes} onChange={set('icd_codes')} placeholder="M54.5" /></div>
          <div><label className="label">Units requested</label>
            <input className="input" type="number" min={1} value={form.units_requested} onChange={set('units_requested')} /></div>
          <div><label className="label">Planned service date</label>
            <input className="input" type="date" value={form.service_date} onChange={set('service_date')} /></div>
          <div className="sm:col-span-2"><label className="label">Needed by</label>
            <input className="input" type="date" value={form.needed_by_date} onChange={set('needed_by_date')} /></div>
          <div className="sm:col-span-2"><label className="label">Notes</label>
            <textarea className="input min-h-[80px]" value={form.notes} onChange={set('notes')} placeholder="Clinical context, payer rep names, reference numbers…" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : auth ? 'Save changes' : 'Create authorization'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Detail drawer ----------------
function AuthDrawer({ authId, payers, team, onClose, onChanged }) {
  const { user } = useAuth();
  const toast = useToast();
  const [auth, setAuth] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [claimSearch, setClaimSearch] = useState('');
  const [claimResults, setClaimResults] = useState([]);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const load = () => api.authzDetail(authId).then(setAuth).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, [authId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const transition = async (status, extra = {}) => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/authz/${authId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Moved to ${STATUS_META[status].label}`);
      load(); onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const addNote = async () => {
    if (!note.trim()) return;
    try {
      const res = await authFetch(`/api/authz/${authId}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setNote(''); load(); toast.success('Note added');
    } catch (e) { toast.error(e.message); }
  };

  const searchClaims = async (q) => {
    setClaimSearch(q);
    if (q.length < 2) { setClaimResults([]); return; }
    try {
      const data = await api.claims({ search: q, limit: 6 });
      setClaimResults(data.claims || []);
    } catch { setClaimResults([]); }
  };

  const linkClaim = async (claimId) => {
    try {
      const res = await authFetch(`/api/authz/${authId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linked_claim_id: claimId }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success('Claim linked');
      setLinking(false); setClaimSearch(''); setClaimResults([]);
      load(); onChanged();
    } catch (e) { toast.error(e.message); }
  };

  const unlinkClaim = async () => {
    try {
      const res = await authFetch(`/api/authz/${authId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linked_claim_id: null }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success('Claim unlinked');
      load(); onChanged();
    } catch (e) { toast.error(e.message); }
  };

  // Pipeline stepper
  const steps = ['draft', 'submitted', 'approved'];
  const stepIdx = auth ? (
    auth.effective_status === 'draft' ? 0
    : auth.effective_status === 'submitted' || auth.effective_status === 'pending_info' ? 1
    : auth.effective_status === 'approved' ? 2 : -1
  ) : -1;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-[520px] bg-white h-full overflow-y-auto shadow-2xl animate-slide-in">
        {!auth ? (
          <div className="p-8 space-y-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>
        ) : (
          <div className="p-7">
            <div className="flex items-start justify-between mb-1">
              <div>
                <div className="text-xs font-semibold text-stone-400 uppercase tracking-wide">Auth #{auth.id}</div>
                <h3 className="text-xl font-bold tracking-tight text-stone-900">{auth.patient_name}</h3>
              </div>
              <button onClick={onClose} className="w-9 h-9 rounded-xl hover:bg-stone-100 flex items-center justify-center text-stone-400 text-xl">×</button>
            </div>
            <div className="flex items-center gap-2 mb-6">
              <StatusPill status={auth.effective_status} />
              <ExpiryBadge auth={auth} />
              {auth.auth_number && <span className="font-mono text-xs text-stone-500 bg-stone-100 rounded-lg px-2.5 py-1">{auth.auth_number}</span>}
            </div>

            {/* Pipeline stepper */}
            {stepIdx >= 0 && (
              <div className="flex items-center mb-7 px-1">
                {steps.map((s, i) => (
                  <div key={s} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                        i < stepIdx ? 'bg-emerald-500 text-white' : i === stepIdx ? 'bg-stone-900 text-white ring-4 ring-stone-900/10' : 'bg-stone-100 text-stone-400'
                      }`}>{i < stepIdx ? '✓' : i + 1}</div>
                      <div className={`text-[10px] font-semibold mt-1.5 ${i <= stepIdx ? 'text-stone-700' : 'text-stone-400'}`}>{STATUS_META[s].label}</div>
                    </div>
                    {i < steps.length - 1 && <div className={`flex-1 h-0.5 mx-2 mb-5 rounded ${i < stepIdx ? 'bg-emerald-500' : 'bg-stone-200'}`} />}
                  </div>
                ))}
              </div>
            )}
            {auth.effective_status === 'pending_info' && (
              <div className="mb-5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                Payer requested more information — respond to keep the clock running.
              </div>
            )}
            {auth.effective_status === 'denied' && auth.denial_reason && (
              <div className="mb-5 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                <strong>Denial reason:</strong> {auth.denial_reason}
              </div>
            )}

            {/* Status actions */}
            {canWrite && TRANSITIONS[auth.status]?.length > 0 && (
              <div className="mb-7">
                <div className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2.5">Move to</div>
                <div className="flex flex-wrap gap-2">
                  {TRANSITIONS[auth.status].map((s) => (
                    <button key={s} disabled={busy} onClick={() => {
                      if (s === 'approved') {
                        const num = window.prompt('Payer auth number:');
                        if (num === null) return;
                        const validTo = window.prompt('Valid through (YYYY-MM-DD):');
                        if (!validTo) { toast.error('Valid-through date is required'); return; }
                        transition(s, { auth_number: num || null, valid_to: validTo, valid_from: new Date().toISOString().slice(0, 10) });
                      } else if (s === 'denied') {
                        const reason = window.prompt('Denial reason from payer:');
                        if (reason === null) return;
                        transition(s, { denial_reason: reason || null });
                      } else {
                        transition(s);
                      }
                    }} className="btn btn-outline !py-2 !text-[13px]">
                      {STATUS_META[s].label} →
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Details */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 mb-7 text-sm">
              {[
                ['Payer', auth.payer_name || '—'],
                ['Provider', auth.provider || '—'],
                ['CPT', auth.cpt_codes || '—'],
                ['ICD', auth.icd_codes || '—'],
                ['Units', `${auth.approved_units ?? '—'} / ${auth.units_requested} requested`],
                ['Assignee', auth.assignee_name || 'Unassigned'],
                ['Requested', auth.requested_date || '—'],
                ['Needed by', auth.needed_by_date || '—'],
                ['Valid', auth.valid_from && auth.valid_to ? `${auth.valid_from} → ${auth.valid_to}` : '—'],
                ['Service date', auth.service_date || '—'],
              ].map(([l, v]) => (
                <div key={l}>
                  <div className="text-xs text-stone-400 font-medium mb-0.5">{l}</div>
                  <div className="text-stone-800 font-medium font-mono text-[13px]">{v}</div>
                </div>
              ))}
            </div>

            {/* Linked claim */}
            <div className="mb-7">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2.5">Linked claim</div>
              {auth.linked_claim_id ? (
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                  <span className="font-mono text-sm font-semibold text-amber-800">{auth.linked_claim_number}</span>
                  {canWrite && <button onClick={unlinkClaim} className="text-xs text-amber-700 hover:underline font-semibold">Unlink</button>}
                </div>
              ) : linking ? (
                <div>
                  <input value={claimSearch} onChange={(e) => searchClaims(e.target.value)}
                    placeholder="Search by claim # or patient…" className="input mb-2" autoFocus />
                  {claimResults.map((c) => (
                    <button key={c.id} onClick={() => linkClaim(c.id)}
                      className="w-full text-left px-4 py-2.5 hover:bg-stone-50 rounded-xl flex justify-between text-sm border-b border-stone-100">
                      <span className="font-mono font-semibold">{c.claim_number}</span>
                      <span className="text-stone-500">{c.patient_name}</span>
                    </button>
                  ))}
                  <button onClick={() => setLinking(false)} className="text-xs text-stone-400 mt-2 hover:underline">Cancel</button>
                </div>
              ) : (
                canWrite && <button onClick={() => setLinking(true)} className="btn btn-outline !py-2 !text-[13px] w-full">+ Link a claim</button>
              )}
            </div>

            {/* Notes */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-400 mb-2.5">Notes</div>
              {canWrite && (
                <div className="flex gap-2 mb-4">
                  <input value={note} onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addNote()}
                    placeholder="Add a note — payer rep, reference #, follow-up…" className="input" />
                  <button onClick={addNote} className="btn btn-dark shrink-0">Add</button>
                </div>
              )}
              <div className="space-y-3">
                {auth.notes?.map((n) => (
                  <div key={n.id} className="flex gap-3 text-sm">
                    <div className="w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-[11px] font-bold text-stone-500 shrink-0">
                      {(n.user_name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2)}
                    </div>
                    <div className="flex-1 bg-stone-50 rounded-xl px-4 py-2.5">
                      <div className="text-stone-700">{n.note}</div>
                      <div className="text-[11px] text-stone-400 mt-1">{n.user_name} · {new Date(n.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                    </div>
                  </div>
                ))}
                {(!auth.notes || auth.notes.length === 0) && <div className="text-sm text-stone-400">No notes yet.</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Main page ----------------
const TABS = [
  { id: '', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'pending_info', label: 'Info Needed' },
  { id: 'approved', label: 'Approved' },
  { id: 'denied', label: 'Denied' },
  { id: 'expired', label: 'Expired' },
];

export default function Authorizations() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [payers, setPayers] = useState([]);
  const [team, setTeam] = useState([]);
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [payer, setPayer] = useState('');
  const [assignee, setAssignee] = useState('');
  const [modal, setModal] = useState(null);
  const [drawerId, setDrawerId] = useState(null);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const load = () => {
    api.authzList({ status: tab, search, payer, assignee }).then(setData).catch((e) => toast.error(e.message));
    api.authzStats().then(setStats).catch(() => {});
  };
  useEffect(() => { load(); }, [tab]);
  useEffect(() => {
    api.payers().then(setPayers).catch(() => {});
    api.team().then(setTeam).catch(() => {});
  }, []);

  const applyFilters = () => load();

  const remove = async (id, patient) => {
    if (!window.confirm(`Delete authorization for ${patient}?`)) return;
    try {
      const res = await authFetch(`/api/authz/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Authorization deleted');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const tabCount = (id) => {
    if (!stats?.byStatus) return 0;
    if (!id) return stats.total;
    if (id === 'expired') return (stats.byStatus.expired || 0) + (stats.expiredUnhandled || 0);
    return stats.byStatus[id] || 0;
  };

  const needsAction = (stats?.byStatus?.pending_info || 0) + (stats?.byStatus?.submitted || 0);

  return (
    <div>
      {modal && <AuthModal auth={modal === 'new' ? null : modal} payers={payers} team={team}
        onClose={() => setModal(null)}
        onSaved={(id) => { setModal(null); load(); if (id) setDrawerId(id); }} />}
      {drawerId && <AuthDrawer authId={drawerId} payers={payers} team={team}
        onClose={() => setDrawerId(null)} onChanged={load} />}

      <PageHeader
        title="Prior Authorizations"
        subtitle="Stop denials before they happen — track every auth from request to expiration"
        actions={canWrite ? [<button key="n" className="btn btn-primary" onClick={() => setModal('new')}>+ New authorization</button>] : []}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          ['Needs action', needsAction, 'text-stone-900', 'Submitted + info-needed'],
          ['Expiring ≤ 14 days', stats?.expiringSoon ?? '—', (stats?.expiringSoon || 0) > 0 ? 'text-amber-600' : 'text-stone-900', 'Approved auths running out'],
          ['Approval rate', stats ? `${stats.approvalRate}%` : '—', 'text-emerald-600', 'Of decided requests'],
          ['Avg turnaround', stats?.turnaround?.length ? `${(stats.turnaround.reduce((a, t) => a + t.avg_days * t.decided, 0) / stats.turnaround.reduce((a, t) => a + t.decided, 0)).toFixed(1)}d` : '—', 'text-stone-900', 'Request → decision'],
        ].map(([l, v, c, s]) => (
          <div key={l} className="card p-5">
            <div className={`text-3xl font-bold tracking-tight ${c}`}>{v}</div>
            <div className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-1">{l}</div>
            <div className="text-[11px] text-stone-400 mt-0.5">{s}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition flex items-center gap-2 ${tab === t.id ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'}`}>
            {t.label}
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-md ${tab === t.id ? 'bg-white/20' : 'bg-stone-100 text-stone-500'}`}>{tabCount(t.id)}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-wrap gap-3 items-end mb-5">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            placeholder="Patient, auth #, CPT, provider…" className="input" />
        </div>
        <div><label className="label">Payer</label>
          <select value={payer} onChange={(e) => setPayer(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {payers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></div>
        <div><label className="label">Assignee</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            <option value="me">Mine</option>
            <option value="unassigned">Unassigned</option>
          </select></div>
        <button onClick={applyFilters} className="btn btn-dark">Filter</button>
        {(search || payer || assignee) && <button onClick={() => { setSearch(''); setPayer(''); setAssignee(''); setTab(''); setTimeout(load, 0); }} className="btn btn-ghost">Clear</button>}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {!data ? (
          <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : data.auths.length === 0 ? (
          <EmptyState icon="📋" title="No authorizations found"
            hint={tab ? 'Nothing in this stage right now.' : 'Create your first auth request to start tracking.'}
            action={canWrite ? <button className="btn btn-primary" onClick={() => setModal('new')}>+ New authorization</button> : null} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl min-w-[900px]">
              <thead><tr>
                <th>Patient</th><th>Payer</th><th>Procedure</th><th>Status</th><th>Timing</th><th>Assignee</th><th>Needed by</th>
                {canWrite && <th className="!text-right">Actions</th>}
              </tr></thead>
              <tbody>
                {data.auths.map((a) => (
                  <tr key={a.id} onClick={() => setDrawerId(a.id)} className="cursor-pointer">
                    <td>
                      <div className="font-semibold text-stone-900">{a.patient_name}</div>
                      <div className="text-[11px] text-stone-400">Auth #{a.id}{a.auth_number ? ` · ${a.auth_number}` : ''}</div>
                    </td>
                    <td className="text-stone-600">{a.payer_name || '—'}</td>
                    <td>
                      <div className="font-mono text-[13px] text-stone-700">{a.cpt_codes || '—'}</div>
                      <div className="text-[11px] text-stone-400 truncate max-w-[180px]">{a.provider || ''}</div>
                    </td>
                    <td><StatusPill status={a.effective_status} /></td>
                    <td><ExpiryBadge auth={a} /></td>
                    <td className="text-stone-600 text-[13px]">{a.assignee_name || <span className="text-stone-300">Unassigned</span>}</td>
                    <td className="text-stone-600 text-[13px]">{a.needed_by_date || '—'}</td>
                    {canWrite && (
                      <td className="!text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex gap-3 justify-end">
                          <button onClick={() => setModal(a)} className="text-amber-700 hover:text-amber-800 text-xs font-semibold">Edit</button>
                          <button onClick={() => remove(a.id, a.patient_name)} className="text-rose-600 hover:text-rose-800 text-xs font-semibold">Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
