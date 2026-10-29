import { useEffect, useState, useRef } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney2 } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton, confirmDialog } from '../components/ui';
import { useToast } from '../components/ui';
import { useOrgSettings } from '../orgSettings';
import CodingAssistant from '../components/CodingAssistant';
import RescueWizard from '../components/RescueWizard';
import CallCopilot from '../components/CallCopilot';

const STATUS_META = {
  paid: { label: 'Paid', badge: 'badge-green' },
  pending: { label: 'Pending', badge: 'badge-blue' },
  in_ar: { label: 'In A/R', badge: 'badge-amber' },
  denied: { label: 'Denied', badge: 'badge-rose' },
};

const EMPTY_FORM = {
  claim_number: '', patient_name: '', payer: '',
  service_date: '', billed_amount: '', paid_amount: '',
  status: 'pending', denial_reason: '',
  cpt_codes: '', icd_codes: '', rendering_npi: '', rendering_provider: '',
};

export function FilingBadge({ days }) {
  if (days == null) return <span className="text-stone-300">—</span>;
  if (days < 0) return <span className="badge badge-rose">Expired {-days}d ago</span>;
  if (days <= 14) return <span className="badge badge-rose">{days}d left</span>;
  if (days <= 30) return <span className="badge badge-amber">{days}d left</span>;
  if (days <= 60) return <span className="text-xs text-stone-500">{days}d</span>;
  return <span className="text-xs text-stone-400">{days}d</span>;
}

// Agent analysis panel (Phase 3) — predictions + recommended actions for
// this claim from /api/agent/claims/:id/analysis. The panel PROPOSES:
// buttons create pending agent actions; approval still happens on the
// standard cards in the Agent tab. Renders nothing when the agent is
// disabled (AGENT_DISABLED) or while loading.
function AgentClaimPanel({ claimId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [spawning, setSpawning] = useState('');
  const [spawned, setSpawned] = useState(new Set());
  const [showCall, setShowCall] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.agent.claimAnalysis(claimId)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live && e && e.code === 'AGENT_DISABLED') setHidden(true); });
    return () => { live = false; };
  }, [claimId, reloadTick]);

  if (hidden || !data) return null;

  const spawn = async (rec) => {
    const key = `${rec.kind}-${rec.era_line_id || ''}`;
    setSpawning(key);
    try {
      await api.agent.propose({ kind: rec.kind, claim_id: claimId, era_line_id: rec.era_line_id || undefined });
      setSpawned((s) => new Set(s).add(key));
      toast.success('Draft created — review and approve it in the Agent tab');
    } catch (e) {
      toast.error(e.message || 'Could not create that draft');
    } finally {
      setSpawning('');
    }
  };

  const pct = (v) => `${Math.round(v * 100)}%`;
  const predLine = (label, p) => (p && p.value != null ? (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-stone-500 w-36 shrink-0">{label}</span>
      <span className="font-medium text-stone-800">{pct(p.value)}</span>
      <span className="text-xs text-stone-400">n={p.sampleSize} · {p.basis}{p.label === 'early estimate' ? ' · early estimate' : ''}</span>
    </div>
  ) : null);

  return (
    <div className="mt-5 pt-5 border-t border-stone-100">
      <div className="flex items-center gap-2 mb-3">
        <span>🤖</span>
        <div className="text-sm font-semibold text-stone-700">Agent analysis</div>
        <span className="text-xs text-stone-400">from this workspace's own history</span>
      </div>
      <div className="space-y-1.5">
        {data.filing_risk && data.filing_risk.days_left != null && (
          <div className="flex items-baseline gap-2 text-sm">
            <span className="text-stone-500 w-36 shrink-0">Filing deadline</span>
            <span className={`font-medium ${data.filing_risk.state === 'expired' || data.filing_risk.state === 'critical' ? 'text-rose-700' : 'text-stone-800'}`}>
              {data.filing_risk.days_left < 0 ? `Expired ${-data.filing_risk.days_left}d ago` : `${data.filing_risk.days_left} days left`}
            </span>
            <span className="text-xs text-stone-400">{data.filing_risk.filing_deadline} · {data.filing_risk.filing_days}-day limit</span>
          </div>
        )}
        {predLine('Appeal overturn', data.appeal_overturn)}
        {predLine('Payment likelihood', data.pay_likelihood)}
        <div className="flex items-baseline gap-2 text-sm">
          <span className="text-stone-500 w-36 shrink-0">Scrub readiness</span>
          <span className="font-medium text-stone-800">{data.scrub.score}/100</span>
          <span className="text-xs text-stone-400">{data.scrub.band_label} · {data.scrub.errors} errors, {data.scrub.warnings} warnings</span>
        </div>
        {data.era_exceptions.length > 0 && (
          <div className="flex items-baseline gap-2 text-sm">
            <span className="text-stone-500 w-36 shrink-0">ERA exceptions</span>
            <span className="font-medium text-stone-800">{data.era_exceptions.length} open</span>
            <span className="text-xs text-stone-400">{data.era_exceptions.map((e) => e.recommendation.label).join('; ')}</span>
          </div>
        )}
      </div>
      {data.recommendations.length > 0 && (
        <div className="mt-3.5 space-y-2">
          {data.recommendations.map((rec, i) => {
            const key = `${rec.kind}-${rec.era_line_id || ''}`;
            const done = spawned.has(key);
            return (
              <div key={i} className="flex items-center gap-3 rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3.5 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-stone-800">{rec.label}</div>
                  {rec.detail && <div className="text-xs text-stone-500 mt-0.5">{rec.detail}</div>}
                </div>
                {rec.spawnable && (
                  <button className="btn btn-primary btn-sm shrink-0" disabled={done || spawning === key} onClick={() => spawn(rec)}>
                    {done ? 'Draft created ✓' : spawning === key ? 'Creating…' : 'Create draft'}
                  </button>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-stone-400">Drafts wait for a person's approval in the Agent tab — creating one changes nothing on this claim.</p>
        </div>
      )}
      {/* Payer-call copilot (Phase 5): history + the brief/log flow */}
      <div className="mt-4">
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium text-stone-800">Payer calls</div>
          <button className="btn btn-dark btn-sm ml-auto" onClick={() => setShowCall(true)}>📞 Call payer</button>
        </div>
        {(data.call_history || []).length === 0 ? (
          <p className="text-xs text-stone-400 mt-1.5">No calls logged yet — the copilot builds the script from this claim's denial and playbook.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {data.call_history.map((c) => (
              <div key={c.id} className="flex items-baseline gap-2 text-[13px]">
                <span className={`badge shrink-0 ${c.outcome === 'promised_payment' ? 'badge-green' : c.outcome === 'denied_upheld' ? 'badge-rose' : 'badge-slate'}`}>{c.outcome_label}</span>
                <span className="text-stone-600 min-w-0">
                  {c.agent_name ? `with ${c.agent_name}` : 'call logged'}
                  {c.reference_number ? ` · ref ${c.reference_number}` : ''}
                  {c.promised_date ? ` · payment promised by ${c.promised_date}` : ''}
                  {c.notes ? ` — ${c.notes}` : ''}
                </span>
                <span className="ml-auto shrink-0 text-[11px] text-stone-400">{new Date(String(c.created_at).replace(' ', 'T') + 'Z').toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showCall && (
        <CallCopilot claimId={claimId} onClose={() => setShowCall(false)} onLogged={() => setReloadTick((t) => t + 1)} />
      )}
    </div>
  );
}

function ClaimModal({ claim, payers, onClose, onSaved, onCheckEligibility, onReviewAgentDrafts }) {
  const [showCoding, setShowCoding] = useState(false);
  const [showRescue, setShowRescue] = useState(false);
  const toast = useToast();
  const [form, setForm] = useState(claim ? {
    claim_number: claim.claim_number, patient_name: claim.patient_name, payer: claim.payer,
    service_date: claim.service_date, billed_amount: claim.billed_amount, paid_amount: claim.paid_amount,
    status: claim.status, denial_reason: claim.denial_reason || '',
    cpt_codes: claim.cpt_codes || '', icd_codes: claim.icd_codes || '',
    rendering_npi: claim.rendering_npi || '', rendering_provider: claim.rendering_provider || '',
  } : { ...EMPTY_FORM });
  const [activity, setActivity] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    if (claim) api.claimDetail(claim.id).then((d) => setActivity(d.activity || [])).catch(() => {});
  }, [claim]);

  const save = async () => {
    setError(null); setSaving(true);
    try {
      const payload = { ...form, billed_amount: Number(form.billed_amount), paid_amount: Number(form.paid_amount || 0) };
      const res = await authFetch(claim ? `/api/claims/${claim.id}` : '/api/claims', {
        method: claim ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).errors?.join('; ') || 'Save failed');
      toast.success(claim ? 'Claim updated' : 'Claim added');
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <>
      <Modal onClose={onClose}>
        <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-5">{claim ? 'Edit claim' : 'Add claim'}</h3>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Claim #</label>
            <input className="input" value={form.claim_number} onChange={set('claim_number')} disabled={!!claim} placeholder="CLM-100001" /></div>
          <div><label className="label">Patient name</label>
            <input className="input" value={form.patient_name} onChange={set('patient_name')} placeholder="Jane Doe" /></div>
          <div><label className="label">Payer</label>
            <select className="input" value={form.payer} onChange={set('payer')}>
              <option value="">Select…</option>
              {payers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select></div>
          <div><label className="label">Service date</label>
            <input type="date" className="input" value={form.service_date} onChange={set('service_date')} /></div>
          <div><label className="label">Billed amount</label>
            <input type="number" step="0.01" min="0" className="input" value={form.billed_amount} onChange={set('billed_amount')} placeholder="0.00" /></div>
          <div><label className="label">Paid amount</label>
            <input type="number" step="0.01" min="0" className="input" value={form.paid_amount} onChange={set('paid_amount')} placeholder="0.00" /></div>
          <div><label className="label">Status</label>
            <select className="input" value={form.status} onChange={set('status')}>
              {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
            </select></div>
          <div><label className="label">Denial reason</label>
            <input className="input" value={form.denial_reason} onChange={set('denial_reason')} placeholder="If denied…" /></div>
        </div>
        <div className="mt-5 pt-5 border-t border-stone-100">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-stone-700">Coding <span className="font-normal text-stone-400">— used by the claim scrubber & 837 export</span></div>
            {claim && (
              <button className="btn btn-sm btn-outline" onClick={() => setShowCoding(true)}>
                ✨ AI code assist
              </button>
            )}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div><label className="label">CPT codes</label>
              <input className="input font-mono" value={form.cpt_codes} onChange={set('cpt_codes')} placeholder="99213, 97110" /></div>
            <div><label className="label">ICD-10 codes</label>
              <input className="input font-mono" value={form.icd_codes} onChange={set('icd_codes')} placeholder="M54.5" /></div>
            <div><label className="label">Rendering provider</label>
              <input className="input" value={form.rendering_provider} onChange={set('rendering_provider')} placeholder="Dr. Jane Smith" /></div>
            <div><label className="label">Rendering NPI</label>
              <input className="input font-mono" value={form.rendering_npi} onChange={set('rendering_npi')} placeholder="10 digits" maxLength={10} /></div>
          </div>
        </div>
        {claim && <AgentClaimPanel claimId={claim.id} />}
        <div className="mt-6 flex justify-end gap-2">
          {claim && claim.status === 'denied' && (
            <button onClick={() => setShowRescue(true)} className="btn btn-dark mr-auto">🛟 Rescue</button>
          )}
          {claim && onCheckEligibility && (
            <button onClick={() => onCheckEligibility(claim)} className={`btn btn-outline ${claim.status === 'denied' ? '' : 'mr-auto'}`}>⚡ Check eligibility</button>
          )}
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : claim ? 'Save changes' : 'Add claim'}</button>
        </div>

        {claim && activity.length > 0 && (
          <div className="mt-6 pt-5 border-t border-stone-100">
            <div className="text-sm font-semibold text-stone-700 mb-3">Activity</div>
            <div className="space-y-2.5 max-h-[200px] overflow-y-auto pr-1">
              {activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 text-[13px]">
                  <span className="text-stone-400 shrink-0 w-32 text-xs">
                    {new Date(a.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className="text-stone-600">
                    <strong className="text-stone-800">{a.user_name || 'System'}</strong> {a.action.replace(/_/g, ' ')}
                    {a.detail && <span className="text-stone-500"> — {a.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
    {showCoding && claim && (
      <CodingAssistant
        claimId={claim.id}
        onClose={() => setShowCoding(false)}
        onApplied={(r) => {
          if (r.claim) {
            setForm((f) => ({ ...f, cpt_codes: r.claim.cpt_codes || '', icd_codes: r.claim.icd_codes || '' }));
          }
        }}
      />
    )}
    {showRescue && claim && (
      <RescueWizard claimId={claim.id} onClose={() => setShowRescue(false)} onReviewDrafts={onReviewAgentDrafts} />
    )}
    </>
  );
}

const BAND_BADGE = { ready: 'badge-green', review: 'badge-amber', blocked: 'badge-rose' };

function bandForScore(score) {
  if (score == null) return null;
  if (score >= 90) return { band: 'ready', band_label: 'Ready to submit' };
  if (score >= 70) return { band: 'review', band_label: 'Review recommended' };
  return { band: 'blocked', band_label: 'Do not submit' };
}

function ScoreBadge({ score, band, band_label, compact }) {
  const meta = band ? { band, band_label } : bandForScore(score);
  if (score == null || !meta) return <span className="text-stone-300">—</span>;
  return (
    <span className={`badge ${BAND_BADGE[meta.band]}`} title={meta.band_label}>
      {compact ? score : `${score} · ${meta.band_label}`}
    </span>
  );
}

function ScrubResultsModal({ result, onClose }) {
  const [filter, setFilter] = useState('all');
  const { summary, results } = result;
  const shown = results.filter((r) =>
    filter === 'all' ? true : filter === 'clean' ? r.status === 'clean' : r.status !== 'clean');

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Scrub results</h3>
        <p className="text-sm text-stone-500 mb-5">Pre-bill validation — fix errors before submitting</p>

        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            ['Checked', summary.total, 'text-stone-900'],
            ['Clean', summary.clean, 'text-emerald-600'],
            ['Warnings', summary.warnings, 'text-amber-600'],
            ['Failed', summary.failed, 'text-rose-600'],
          ].map(([l, v, c]) => (
            <div key={l} className="bg-stone-50 rounded-xl p-4 text-center">
              <div className={`text-2xl font-bold ${c}`}>{v}</div>
              <div className="text-xs text-stone-500 mt-0.5">{l}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-4">
          {[['all', 'All'], ['issues', 'With issues'], ['clean', 'Clean']].map(([v, l]) => (
            <button key={v} onClick={() => setFilter(v)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${filter === v ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600'}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
          {shown.map((r) => (
            <div key={r.claim_id} className={`border rounded-xl p-4 ${r.status === 'failed' ? 'border-rose-200 bg-rose-50/40' : r.status === 'warnings' ? 'border-amber-200 bg-amber-50/40' : 'border-emerald-200 bg-emerald-50/40'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono font-bold text-sm">{r.claim_number}</span>
                <div className="flex items-center gap-2">
                  <ScoreBadge score={r.score} band={r.band} band_label={r.band_label} />
                  <span className={`badge ${r.status === 'failed' ? 'badge-rose' : r.status === 'warnings' ? 'badge-amber' : 'badge-green'}`}>
                    {r.status === 'clean' ? '✓ Clean' : `${r.errors} errors · ${r.warnings} warnings`}
                  </span>
                </div>
              </div>
              {r.issues.map((iss, i) => (
                <div key={i} className="flex gap-2.5 text-sm py-1">
                  <span className={`badge shrink-0 ${iss.severity === 'error' ? 'badge-rose' : 'badge-amber'}`}>{iss.rule}</span>
                  <span className="text-stone-700">{iss.message}</span>
                </div>
              ))}
            </div>
          ))}
          {shown.length === 0 && <div className="text-sm text-stone-400 text-center py-6">Nothing in this view.</div>}
        </div>

        <div className="flex justify-end mt-6">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Claims({ onCheckEligibility, initialClaimId, onConsumed, onReviewAgentDrafts }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [payers, setPayers] = useState([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [payer, setPayer] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [scrubResult, setScrubResult] = useState(null);
  const fileRef = useRef(null);
  const { settings } = useOrgSettings() || {};
  const limit = settings?.rows_per_page || 20;
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const fetchClaims = () => api.claims({ search, status, payer, page, limit }).then((d) => { setData(d); setSelected(new Set()); }).catch((e) => toast.error(e.message));

  // Cross-page deep link (My Work "Open claim", EHR "View claim"): fetch the
  // claim directly — it may sit on any page of the paginated list — and open
  // it in the same modal the list's Edit button uses.
  useEffect(() => {
    if (!initialClaimId) return;
    let cancelled = false;
    api.claimDetail(initialClaimId)
      .then((d) => { if (!cancelled) setModal(d); })
      .catch(() => { if (!cancelled) toast.error('That claim could not be opened'); })
      .finally(() => { if (!cancelled) onConsumed?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialClaimId]);

  useEffect(() => { api.payers().then(setPayers).catch(() => {}); }, []);
  useEffect(() => { fetchClaims(); }, [page, limit]);

  const applyFilters = () => { setPage(1); fetchClaims(); };
  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  const toggleSelect = (id) => {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleAll = () => {
    if (!data) return;
    setSelected((s) => s.size === data.claims.length ? new Set() : new Set(data.claims.map((c) => c.id)));
  };

  const bulkAction = async (action, value, label) => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const res = await api.bulkClaims([...selected], action, value);
      toast.success(action === 'start_appeals'
        ? `${res.appeals_created} appeals opened`
        : `${res.updated} claims updated — ${label}`);
      fetchClaims();
    } catch (e) { toast.error(e.message); }
    finally { setBulkBusy(false); }
  };

  const runScrub = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const res = await authFetch('/api/scrub/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claim_ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setScrubResult(data);
    } catch (e) { toast.error(e.message); }
    finally { setBulkBusy(false); }
  };

  const export837 = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const token = localStorage.getItem('pulse_token');
      const res = await fetch('/api/claims/export-837', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ claim_ids: [...selected] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `claims-837P-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('837P file downloaded — upload it to your clearinghouse');
    } catch (e) { toast.error(e.message); }
    finally { setBulkBusy(false); }
  };

  const handleDelete = async (id, claimNumber) => {
    if (!(await confirmDialog({ title: `Delete claim ${claimNumber}?`, body: 'This cannot be undone.', confirmLabel: 'Delete claim' }))) return;
    try {
      const res = await authFetch(`/api/claims/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Claim deleted');
      fetchClaims();
    } catch (e) { toast.error(e.message); }
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadResult(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await authFetch('/api/claims/upload/csv', { method: 'POST', body: fd });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Upload failed');
      setUploadResult(result);
      toast.success(`${result.inserted} claims imported`);
      fetchClaims();
    } catch (err) { setUploadResult({ error: err.message }); }
    e.target.value = '';
  };

  const [import837Result, setImport837Result] = useState(null);
  const file837Ref = useRef(null);
  const handleUpload837 = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImport837Result(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await authFetch('/api/claims/upload/837', { method: 'POST', body: fd });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Import failed');
      setImport837Result(result);
      toast.success(`${result.inserted} claims imported from 837`);
      fetchClaims();
      api.payers().then(setPayers).catch(() => {});
    } catch (err) { setImport837Result({ error: err.message }); }
    e.target.value = '';
  };

  return (
    <div>
      {modal && <ClaimModal claim={modal === 'add' ? null : modal} payers={payers}
        onClose={() => setModal(null)} onSaved={() => { setModal(null); fetchClaims(); }}
        onCheckEligibility={onCheckEligibility} onReviewAgentDrafts={onReviewAgentDrafts} />}

      <PageHeader
        title="Claims"
        subtitle={data ? `${data.total.toLocaleString()} claims in your workspace` : ''}
        actions={canWrite ? [
          <button key="add" className="btn btn-primary" onClick={() => setModal('add')}>+ Add claim</button>,
          <button key="up" className="btn btn-outline" onClick={() => fileRef.current.click()}>⬆ Upload CSV</button>,
          <button key="i837" className="btn btn-outline" onClick={() => file837Ref.current.click()}>⬆ Import 837</button>,
        ] : []}
      />
      {canWrite && (
        <div className="mb-5">
          <a href="/api/claims/template/csv" className="text-xs text-stone-500 hover:text-stone-700 underline underline-offset-2">
            Download CSV template
          </a>
          <span className="text-xs text-stone-400 ml-3">Import 837: drop in the claim file your EHR exports — claims land in the worklist, no re-keying.</span>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
          <input ref={file837Ref} type="file" accept=".837,.txt,.edi,.dat,.x12" className="hidden" onChange={handleUpload837} />
        </div>
      )}

      {import837Result && (
        <div className={`rounded-2xl border px-5 py-4 text-sm mb-5 ${import837Result.error ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {import837Result.error ? <>837 import failed: {import837Result.error}</> : (
            <><strong>{import837Result.inserted} of {import837Result.total}</strong> claims imported from the 837 file.
              {import837Result.payers_created?.length > 0 && <div className="mt-1">New payers created from the file: {import837Result.payers_created.join(', ')} — set their filing deadlines under Filing Rules.</div>}
              {import837Result.skipped?.length > 0 && (
                <details className="mt-2"><summary className="cursor-pointer font-medium">{import837Result.skipped.length} claims skipped</summary>
                  <ul className="mt-1 space-y-1 text-xs">
                    {import837Result.skipped.slice(0, 10).map((s, i) => <li key={i}>{s.claim_number}: {s.reason}</li>)}
                  </ul></details>)}
              {import837Result.errors?.length > 0 && <div className="mt-1 text-xs">{import837Result.errors.slice(0, 5).join(' · ')}</div>}
            </>)}
          <button onClick={() => setImport837Result(null)} className="ml-3 underline">dismiss</button>
        </div>
      )}

      {uploadResult && (
        <div className={`rounded-2xl border px-5 py-4 text-sm mb-5 ${uploadResult.error ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {uploadResult.error ? <>Upload failed: {uploadResult.error}</> : (
            <><strong>{uploadResult.inserted} of {uploadResult.total}</strong> claims imported.
              {uploadResult.skipped.length > 0 && (
                <details className="mt-2"><summary className="cursor-pointer font-medium">{uploadResult.skipped.length} rows skipped</summary>
                  <ul className="mt-1 space-y-1 text-xs">
                    {uploadResult.skipped.slice(0, 10).map((s, i) => <li key={i}>Row {s.row} ({s.claim_number}): {s.errors.join('; ')}</li>)}
                  </ul></details>)}
            </>)}
          <button onClick={() => setUploadResult(null)} className="ml-3 underline">dismiss</button>
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-3 items-end mb-5">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            placeholder="Claim # or patient name…" className="input" />
        </div>
        <div><label className="label">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {Object.entries(STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select></div>
        <div><label className="label">Payer</label>
          <select value={payer} onChange={(e) => setPayer(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {payers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></div>
        <button onClick={applyFilters} className="btn btn-dark">Filter</button>
      </div>

      {/* Bulk action bar */}
      {canWrite && selected.size > 0 && (
        <div className="sticky top-4 z-30 mb-4 flex items-center gap-2 bg-stone-900 text-white rounded-2xl px-5 py-3 shadow-lg flex-wrap">
          <span className="text-sm font-semibold mr-2">{selected.size} selected</span>
          <button disabled={bulkBusy} onClick={() => bulkAction('touch', null, 'marked as worked')} className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">✓ Mark worked</button>
          <button disabled={bulkBusy} onClick={() => bulkAction('set_status', 'in_ar', 'moved to A/R')} className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">→ Move to A/R</button>
          <button disabled={bulkBusy} onClick={() => bulkAction('start_appeals', 'medium', '')} className="btn !bg-emerald-500 hover:!bg-emerald-600 !text-white !py-1.5 !text-xs">⚠️ Open appeals</button>
          <button disabled={bulkBusy} onClick={runScrub} className="btn !bg-amber-500 hover:!bg-amber-700 !text-white !py-1.5 !text-xs">🔍 Scrub claims</button>
          <button disabled={bulkBusy} onClick={export837} className="btn !bg-amber-500 hover:!bg-amber-700 !text-white !py-1.5 !text-xs">📄 Export 837P</button>
          <button onClick={() => setSelected(new Set())} className="btn !text-stone-300 hover:!text-white !py-1.5 !text-xs ml-auto">Clear</button>
        </div>
      )}
      {scrubResult && <ScrubResultsModal result={scrubResult} onClose={() => { setScrubResult(null); fetchClaims(); }} />}

      {!data ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : data.claims.length === 0 ? (
        <div className="card"><EmptyState icon="📋" title="No claims found"
          hint="Try adjusting your filters, or add your first claim to get started." /></div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr>
                {canWrite && <th className="!pr-0 w-10"><input type="checkbox" checked={data.claims.length > 0 && selected.size === data.claims.length} onChange={toggleAll} className="rounded" /></th>}
                <th>Claim #</th><th>Patient</th><th>Payer</th><th>Service date</th>
                <th className="!text-right">Billed</th><th className="!text-right">Paid</th>
                <th>Status</th><th>Readiness</th><th>Filing deadline</th><th className="!text-right">Days in A/R</th>
                {canWrite && <th className="!text-center">Actions</th>}
              </tr></thead>
              <tbody>
                {data.claims.map((c) => (
                  <tr key={c.id} className={selected.has(c.id) ? '!bg-emerald-50/60' : ''}>
                    {canWrite && <td className="!pr-0"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="rounded" /></td>}
                    <td className="font-mono text-xs text-stone-500">{c.claim_number}</td>
                    <td className="font-medium">{c.patient_name}</td>
                    <td className="text-stone-500">{c.payer}</td>
                    <td className="text-stone-500">{c.service_date}</td>
                    <td className="!text-right font-medium">{fmtMoney2(c.billed_amount)}</td>
                    <td className="!text-right text-stone-500">{fmtMoney2(c.paid_amount)}</td>
                    <td>
                      <span className={`badge ${STATUS_META[c.status].badge}`}>{STATUS_META[c.status].label}</span>
                      {c.denial_reason && <div className="text-[11px] text-rose-600 mt-1">{c.denial_reason}</div>}
                    </td>
                    <td><ScoreBadge score={c.readiness_score} compact /></td>
                    <td><FilingBadge days={c.days_until_filing} /></td>
                    <td className="!text-right text-stone-500">{c.days_in_ar}</td>
                    {canWrite && (
                      <td className="!text-center whitespace-nowrap">
                        <button onClick={() => setModal(c)} className="text-amber-700 hover:text-amber-800 text-xs font-semibold mr-3">Edit</button>
                        <button onClick={() => handleDelete(c.id, c.claim_number)} className="text-rose-600 hover:text-rose-800 text-xs font-semibold">Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between mt-4 text-sm text-stone-500">
          <div>{data.total.toLocaleString()} claims</div>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn btn-outline !px-3 !py-1.5">← Prev</button>
            <span className="text-xs">Page {page} of {totalPages || 1}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="btn btn-outline !px-3 !py-1.5">Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}
