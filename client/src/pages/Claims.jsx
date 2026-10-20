import { useEffect, useState, useRef } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney2 } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

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
  if (days == null) return <span className="text-slate-300">—</span>;
  if (days < 0) return <span className="badge badge-rose">Expired {-days}d ago</span>;
  if (days <= 14) return <span className="badge badge-rose">{days}d left</span>;
  if (days <= 30) return <span className="badge badge-amber">{days}d left</span>;
  if (days <= 60) return <span className="text-xs text-slate-500">{days}d</span>;
  return <span className="text-xs text-slate-400">{days}d</span>;
}

function ClaimModal({ claim, payers, onClose, onSaved }) {
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
        <div className="mt-5 pt-5 border-t border-slate-100">
          <div className="text-sm font-semibold text-slate-700 mb-3">Coding <span className="font-normal text-slate-400">— used by the claim scrubber & 837 export</span></div>
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
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={save} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : claim ? 'Save changes' : 'Add claim'}</button>
        </div>

        {claim && activity.length > 0 && (
          <div className="mt-6 pt-5 border-t border-slate-100">
            <div className="text-sm font-semibold text-slate-700 mb-3">Activity</div>
            <div className="space-y-2.5 max-h-[200px] overflow-y-auto pr-1">
              {activity.map((a) => (
                <div key={a.id} className="flex items-center gap-2.5 text-[13px]">
                  <span className="text-slate-400 shrink-0 w-32 text-xs">
                    {new Date(a.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className="text-slate-600">
                    <strong className="text-slate-800">{a.user_name || 'System'}</strong> {a.action.replace(/_/g, ' ')}
                    {a.detail && <span className="text-slate-500"> — {a.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
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
        <p className="text-sm text-slate-500 mb-5">Pre-bill validation — fix errors before submitting</p>

        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            ['Checked', summary.total, 'text-slate-900'],
            ['Clean', summary.clean, 'text-emerald-600'],
            ['Warnings', summary.warnings, 'text-amber-600'],
            ['Failed', summary.failed, 'text-rose-600'],
          ].map(([l, v, c]) => (
            <div key={l} className="bg-slate-50 rounded-xl p-4 text-center">
              <div className={`text-2xl font-bold ${c}`}>{v}</div>
              <div className="text-xs text-slate-500 mt-0.5">{l}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-4">
          {[['all', 'All'], ['issues', 'With issues'], ['clean', 'Clean']].map(([v, l]) => (
            <button key={v} onClick={() => setFilter(v)}
              className={`px-3.5 py-1.5 rounded-lg text-sm font-medium ${filter === v ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
          {shown.map((r) => (
            <div key={r.claim_id} className={`border rounded-xl p-4 ${r.status === 'failed' ? 'border-rose-200 bg-rose-50/40' : r.status === 'warnings' ? 'border-amber-200 bg-amber-50/40' : 'border-emerald-200 bg-emerald-50/40'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono font-bold text-sm">{r.claim_number}</span>
                <span className={`badge ${r.status === 'failed' ? 'badge-rose' : r.status === 'warnings' ? 'badge-amber' : 'badge-green'}`}>
                  {r.status === 'clean' ? '✓ Clean' : `${r.errors} errors · ${r.warnings} warnings`}
                </span>
              </div>
              {r.issues.map((iss, i) => (
                <div key={i} className="flex gap-2.5 text-sm py-1">
                  <span className={`badge shrink-0 ${iss.severity === 'error' ? 'badge-rose' : 'badge-amber'}`}>{iss.rule}</span>
                  <span className="text-slate-700">{iss.message}</span>
                </div>
              ))}
            </div>
          ))}
          {shown.length === 0 && <div className="text-sm text-slate-400 text-center py-6">Nothing in this view.</div>}
        </div>

        <div className="flex justify-end mt-6">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Claims() {
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
  const limit = 20;
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const fetchClaims = () => api.claims({ search, status, payer, page, limit }).then((d) => { setData(d); setSelected(new Set()); }).catch((e) => toast.error(e.message));
  useEffect(() => { api.payers().then(setPayers).catch(() => {}); }, []);
  useEffect(() => { fetchClaims(); }, [page]);

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
    if (!window.confirm(`Delete claim ${claimNumber}? This cannot be undone.`)) return;
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

  return (
    <div>
      {modal && <ClaimModal claim={modal === 'add' ? null : modal} payers={payers}
        onClose={() => setModal(null)} onSaved={() => { setModal(null); fetchClaims(); }} />}

      <PageHeader
        title="Claims"
        subtitle={data ? `${data.total.toLocaleString()} claims in your workspace` : ''}
        actions={canWrite ? [
          <button key="add" className="btn btn-primary" onClick={() => setModal('add')}>+ Add claim</button>,
          <button key="up" className="btn btn-outline" onClick={() => fileRef.current.click()}>⬆ Upload CSV</button>,
        ] : []}
      />
      {canWrite && (
        <div className="mb-5">
          <a href="/api/claims/template/csv" className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2">
            Download CSV template
          </a>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleUpload} />
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
        <div className="sticky top-4 z-30 mb-4 flex items-center gap-2 bg-slate-900 text-white rounded-2xl px-5 py-3 shadow-lg flex-wrap">
          <span className="text-sm font-semibold mr-2">{selected.size} selected</span>
          <button disabled={bulkBusy} onClick={() => bulkAction('touch', null, 'marked as worked')} className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">✓ Mark worked</button>
          <button disabled={bulkBusy} onClick={() => bulkAction('set_status', 'in_ar', 'moved to A/R')} className="btn !bg-white/10 hover:!bg-white/20 !text-white !py-1.5 !text-xs">→ Move to A/R</button>
          <button disabled={bulkBusy} onClick={() => bulkAction('start_appeals', 'medium', '')} className="btn !bg-emerald-500 hover:!bg-emerald-600 !text-white !py-1.5 !text-xs">⚠️ Open appeals</button>
          <button disabled={bulkBusy} onClick={runScrub} className="btn !bg-sky-500 hover:!bg-sky-600 !text-white !py-1.5 !text-xs">🔍 Scrub claims</button>
          <button disabled={bulkBusy} onClick={export837} className="btn !bg-violet-500 hover:!bg-violet-600 !text-white !py-1.5 !text-xs">📄 Export 837P</button>
          <button onClick={() => setSelected(new Set())} className="btn !text-slate-300 hover:!text-white !py-1.5 !text-xs ml-auto">Clear</button>
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
                <th>Status</th><th>Filing deadline</th><th className="!text-right">Days in A/R</th>
                {canWrite && <th className="!text-center">Actions</th>}
              </tr></thead>
              <tbody>
                {data.claims.map((c) => (
                  <tr key={c.id} className={selected.has(c.id) ? '!bg-emerald-50/60' : ''}>
                    {canWrite && <td className="!pr-0"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="rounded" /></td>}
                    <td className="font-mono text-xs text-slate-500">{c.claim_number}</td>
                    <td className="font-medium">{c.patient_name}</td>
                    <td className="text-slate-500">{c.payer}</td>
                    <td className="text-slate-500">{c.service_date}</td>
                    <td className="!text-right font-medium">{fmtMoney2(c.billed_amount)}</td>
                    <td className="!text-right text-slate-500">{fmtMoney2(c.paid_amount)}</td>
                    <td>
                      <span className={`badge ${STATUS_META[c.status].badge}`}>{STATUS_META[c.status].label}</span>
                      {c.denial_reason && <div className="text-[11px] text-rose-600 mt-1">{c.denial_reason}</div>}
                    </td>
                    <td><FilingBadge days={c.days_until_filing} /></td>
                    <td className="!text-right text-slate-500">{c.days_in_ar}</td>
                    {canWrite && (
                      <td className="!text-center whitespace-nowrap">
                        <button onClick={() => setModal(c)} className="text-sky-600 hover:text-sky-800 text-xs font-semibold mr-3">Edit</button>
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
        <div className="flex items-center justify-between mt-4 text-sm text-slate-500">
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
