import { useEffect, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api } from '../api';
import { PageHeader, Skeleton, EmptyState, Modal } from '../components/ui';
import { useToast } from '../components/ui';

const STATUS_META = {
  active: { label: 'Active', cls: 'badge-green' },
  inactive: { label: 'Inactive', cls: 'badge-rose' },
  unknown: { label: 'Not verified', cls: 'badge-slate' },
};

const EMPTY = {
  patient_name: '', payer_id: '', service_date: '', coverage_status: 'unknown',
  verified_via: '', effective_date: '', copay: '', deductible_remaining: '', notes: '',
};

function EligibilityModal({ record, payers, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(record ? {
    patient_name: record.patient_name, payer_id: record.payer_id || '',
    service_date: record.service_date || '', coverage_status: record.coverage_status,
    verified_via: record.verified_via || '', effective_date: record.effective_date || '',
    copay: record.copay ?? '', deductible_remaining: record.deductible_remaining ?? '',
    notes: record.notes || '',
  } : { ...EMPTY });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const payload = {
        ...form,
        payer_id: form.payer_id ? Number(form.payer_id) : null,
        copay: form.copay === '' ? null : Number(form.copay),
        deductible_remaining: form.deductible_remaining === '' ? null : Number(form.deductible_remaining),
      };
      Object.keys(payload).forEach((k) => { if (payload[k] === '') payload[k] = null; });
      const res = await authFetch(record ? `/api/eligibility/${record.id}` : '/api/eligibility', {
        method: record ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(record ? 'Verification updated' : 'Verification logged');
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">{record ? 'Update verification' : 'Log eligibility check'}</h3>
        <p className="text-sm text-slate-500 mb-5">Record the outcome of a payer portal or phone verification</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className="label">Patient name *</label>
            <input className="input" value={form.patient_name} onChange={set('patient_name')} placeholder="Jane Doe" /></div>
          <div><label className="label">Payer</label>
            <select className="input" value={form.payer_id} onChange={set('payer_id')}>
              <option value="">Select payer…</option>
              {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
          <div><label className="label">Service date</label>
            <input className="input" type="date" value={form.service_date} onChange={set('service_date')} /></div>
          <div><label className="label">Coverage status</label>
            <select className="input" value={form.coverage_status} onChange={set('coverage_status')}>
              <option value="unknown">Not verified</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select></div>
          <div><label className="label">Verified via</label>
            <select className="input" value={form.verified_via} onChange={set('verified_via')}>
              <option value="">—</option>
              <option value="portal">Payer portal</option>
              <option value="phone">Phone call</option>
              <option value="clearinghouse">Clearinghouse</option>
              <option value="other">Other</option>
            </select></div>
          <div><label className="label">Effective date</label>
            <input className="input" type="date" value={form.effective_date} onChange={set('effective_date')} /></div>
          <div><label className="label">Copay $</label>
            <input className="input" type="number" step="0.01" min="0" value={form.copay} onChange={set('copay')} placeholder="0.00" /></div>
          <div><label className="label">Deductible remaining $</label>
            <input className="input" type="number" step="0.01" min="0" value={form.deductible_remaining} onChange={set('deductible_remaining')} placeholder="0.00" /></div>
          <div className="sm:col-span-2"><label className="label">Notes</label>
            <textarea className="input min-h-[70px]" value={form.notes} onChange={set('notes')} placeholder="Rep name, reference #, plan details…" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : record ? 'Save changes' : 'Log check'}</button>
        </div>
      </div>
    </Modal>
  );
}

const TABS = [
  { id: '', label: 'All' },
  { id: 'unknown', label: 'Not verified' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

function BenefitRow({ label, value }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-900">{value ?? '—'}</span>
    </div>
  );
}

function RealTimeCheck({ payers, prefill, onConsumed, canWrite }) {
  const toast = useToast();
  const [form, setForm] = useState({
    patient_first: '', patient_last: '', dob: '', member_id: '',
    payer_id: '', date_of_service: todayISO(),
  });
  const [mode, setMode] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => { api.eligibility.mode().then(setMode).catch(() => {}); }, []);
  useEffect(() => {
    api.eligibility.history(10).then((d) => setHistory(d.lookups)).catch(() => {});
  }, []);

  // One-time prefill from the claim drawer deep link
  useEffect(() => {
    if (!prefill) return;
    const { first, last } = splitName(prefill.patientName);
    setForm((f) => ({
      ...f,
      patient_first: first, patient_last: last,
      payer_id: prefill.payerId ? String(prefill.payerId) : f.payer_id,
      date_of_service: prefill.serviceDate || f.date_of_service,
    }));
    onConsumed && onConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const check = async () => {
    setError(null); setResult(null); setBusy(true);
    try {
      const payload = { ...form, payer_id: form.payer_id ? Number(form.payer_id) : null };
      const r = await api.eligibility.check(payload);
      setResult(r);
      const h = await api.eligibility.history(10);
      setHistory(h.lookups);
      if (r.demo) toast.success('Check complete (demo response)');
      else toast.success('Check complete');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const openDetail = async (id) => {
    try { setDetail(await api.eligibility.lookup(id)); }
    catch (e) { toast.error(e.message); }
  };

  const money = (n) => n == null ? '—' : `$${Number(n).toFixed(2)}`;

  return (
    <div className="card p-6 mb-6">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="text-xl">⚡</div>
        <div className="font-semibold text-slate-900">Real-time eligibility check</div>
        {mode?.demo && <span className="badge badge-amber">DEMO MODE — synthetic data</span>}
        {mode && !mode.demo && <span className="badge badge-green">LIVE VENDOR</span>}
      </div>
      <p className="text-sm text-slate-500 mb-5 max-w-2xl leading-relaxed">
        Run a 270/271-style check against the payer before the visit.
        {mode?.demo && ' Currently in demo mode — responses are synthetic. Connect a real vendor in Organization settings.'}
      </p>
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}

      <div className="grid sm:grid-cols-3 gap-4 mb-4">
        <div><label className="label">First name *</label>
          <input className="input" value={form.patient_first} onChange={set('patient_first')} placeholder="Jane" /></div>
        <div><label className="label">Last name *</label>
          <input className="input" value={form.patient_last} onChange={set('patient_last')} placeholder="Doe" /></div>
        <div><label className="label">Date of birth *</label>
          <input className="input" type="date" value={form.dob} onChange={set('dob')} /></div>
        <div><label className="label">Member ID *</label>
          <input className="input" value={form.member_id} onChange={set('member_id')} placeholder="ABC123456" /></div>
        <div><label className="label">Payer *</label>
          <select className="input" value={form.payer_id} onChange={set('payer_id')}>
            <option value="">Select payer…</option>
            {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div><label className="label">Date of service *</label>
          <input className="input" type="date" value={form.date_of_service} onChange={set('date_of_service')} /></div>
      </div>
      <button className="btn btn-primary !px-8 !py-2.5" onClick={check} disabled={busy || !canWrite}>
        {busy ? 'Checking…' : '⚡ Check eligibility'}
      </button>
      {!canWrite && <p className="text-xs text-slate-400 mt-2">Only owners and billers can run checks.</p>}

      {result && (
        <div className="mt-6 rounded-2xl border overflow-hidden">
          <div className={`px-5 py-4 flex items-center justify-between ${result.coverage_active ? 'bg-emerald-600' : 'bg-rose-600'}`}>
            <div className="text-white font-extrabold text-lg tracking-tight">
              {result.coverage_active ? '✓ COVERAGE ACTIVE' : '✕ COVERAGE INACTIVE'}
            </div>
            <div className="text-white/80 text-xs">{result.payer} · DOS {result.date_of_service}</div>
          </div>
          {result.demo && (
            <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 font-medium">
              DEMO MODE — synthetic response, not a real 271. Connect a real eligibility vendor in Organization settings.
            </div>
          )}
          <div className="px-5 py-4 grid sm:grid-cols-2 gap-x-8">
            <div>
              <BenefitRow label="Patient" value={`${result.patient_first} ${result.patient_last}`} />
              <BenefitRow label="Member ID" value={result.member_id} />
              <BenefitRow label="Group #" value={result.group_number} />
              <BenefitRow label="Plan" value={result.plan_name} />
              <BenefitRow label="Plan type" value={result.plan_type} />
            </div>
            <div>
              <BenefitRow label="PCP copay" value={money(result.copay_primary)} />
              <BenefitRow label="Specialist copay" value={money(result.copay_specialist)} />
              <BenefitRow label="Deductible (individual)" value={money(result.deductible_individual)} />
              <BenefitRow label="Deductible remaining" value={money(result.deductible_remaining)} />
              <BenefitRow label="OOP max" value={money(result.oop_max)} />
              <BenefitRow label="Effective" value={result.effective_date || '—'} />
              <BenefitRow label="Term" value={result.term_date || '—'} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-6">
        <div className="text-sm font-bold text-slate-900 mb-2">Recent checks</div>
        {!history ? (
          <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        ) : history.length === 0 ? (
          <p className="text-sm text-slate-400">No real-time checks yet — run your first one above.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="w-full tbl min-w-[640px]">
              <thead><tr><th>Patient</th><th>Payer</th><th>DOS</th><th>Coverage</th><th>Source</th><th>Checked</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} onClick={() => openDetail(h.id)} className="cursor-pointer hover:bg-slate-50">
                    <td className="font-medium text-slate-900">{h.patient_first} {h.patient_last}</td>
                    <td className="text-slate-600">{h.payer}</td>
                    <td className="text-slate-600 text-[13px]">{h.date_of_service}</td>
                    <td>{h.coverage_active
                      ? <span className="badge badge-green">Active</span>
                      : <span className="badge badge-rose">Inactive</span>}</td>
                    <td>{h.demo ? <span className="badge badge-amber">Demo</span> : <span className="badge badge-sky">Live</span>}</td>
                    <td className="text-slate-500 text-[13px]">{h.created_at?.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && (
        <Modal onClose={() => setDetail(null)} wide>
          <div className="p-7">
            <h3 className="text-xl font-bold tracking-tight mb-1">
              {detail.patient_first} {detail.patient_last} <span className="text-slate-400 font-normal text-base">· {detail.payer}</span>
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              Checked {detail.created_at?.slice(0, 16).replace('T', ' ')} · {detail.demo ? 'Demo (synthetic)' : 'Live vendor'}
            </p>
            <div className={`rounded-xl px-4 py-3 mb-4 font-bold ${detail.coverage_active ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'}`}>
              {detail.coverage_active ? '✓ COVERAGE ACTIVE' : '✕ COVERAGE INACTIVE'}
            </div>
            <div className="grid sm:grid-cols-2 gap-x-8 mb-4">
              <div>
                <BenefitRow label="Member ID" value={detail.member_id} />
                <BenefitRow label="DOB" value={detail.dob} />
                <BenefitRow label="Group #" value={detail.group_number} />
                <BenefitRow label="Plan" value={detail.plan_name} />
                <BenefitRow label="Plan type" value={detail.plan_type} />
              </div>
              <div>
                <BenefitRow label="PCP copay" value={money(detail.copay_primary)} />
                <BenefitRow label="Specialist copay" value={money(detail.copay_specialist)} />
                <BenefitRow label="Deductible (individual)" value={money(detail.deductible_individual)} />
                <BenefitRow label="Deductible remaining" value={money(detail.deductible_remaining)} />
                <BenefitRow label="OOP max" value={money(detail.oop_max)} />
              </div>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-slate-600 mb-2">Raw 271-style payload (vendor response)</summary>
              <pre className="bg-slate-900 text-slate-200 rounded-xl p-4 overflow-x-auto max-h-64">
                {JSON.stringify(JSON.parse(detail.raw_response || '{}'), null, 2)}
              </pre>
            </details>
            <div className="flex justify-end mt-5">
              <button onClick={() => setDetail(null)} className="btn btn-ghost">Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Eligibility({ initialPrefill, onConsumed }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [payers, setPayers] = useState([]);
  const [tab, setTab] = useState('');
  const [search, setSearch] = useState('');
  const [payer, setPayer] = useState('');
  const [modal, setModal] = useState(null);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const load = () => {
    authFetch(`/api/eligibility?${new URLSearchParams({ status: tab, search, payer })}`)
      .then((r) => r.json()).then(setData).catch((e) => toast.error(e.message));
    authFetch('/api/eligibility/stats').then((r) => r.json()).then(setStats).catch(() => {});
  };
  useEffect(() => { load(); }, [tab]);
  useEffect(() => { api.payers().then(setPayers).catch(() => {}); }, []);

  const remove = async (id, patient) => {
    if (!window.confirm(`Delete eligibility record for ${patient}?`)) return;
    try {
      const res = await authFetch(`/api/eligibility/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Record deleted');
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      {modal && <EligibilityModal record={modal === 'new' ? null : modal} payers={payers}
        onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}

      <PageHeader
        title="Eligibility Verification"
        subtitle="Verify coverage before the visit — inactive insurance is a denial waiting to happen"
        actions={canWrite ? [<button key="n" className="btn btn-primary" onClick={() => setModal('new')}>+ Log check</button>] : []}
      />

      <RealTimeCheck payers={payers} prefill={initialPrefill} onConsumed={onConsumed} canWrite={canWrite} />

      <div className="text-sm font-bold text-slate-900 mb-2 mt-8">Manual verification log</div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          ['Upcoming unverified', stats?.upcomingUnverified ?? '—', (stats?.upcomingUnverified || 0) > 0 ? 'text-amber-600' : 'text-slate-900', 'Service within 7 days'],
          ['Active', stats?.byStatus?.active || 0, 'text-emerald-600', 'Coverage confirmed'],
          ['Inactive', stats?.byStatus?.inactive || 0, (stats?.byStatus?.inactive || 0) > 0 ? 'text-rose-600' : 'text-slate-900', 'Needs action before visit'],
          ['Not verified', stats?.byStatus?.unknown || 0, 'text-slate-900', 'Still to check'],
        ].map(([l, v, c, s]) => (
          <div key={l} className="card p-5">
            <div className={`text-3xl font-bold tracking-tight ${c}`}>{v}</div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mt-1">{l}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{s}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${tab === t.id ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card p-4 flex flex-wrap gap-3 items-end mb-5">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Patient name…" className="input" />
        </div>
        <div><label className="label">Payer</label>
          <select value={payer} onChange={(e) => setPayer(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {payers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></div>
        <button onClick={load} className="btn btn-dark">Filter</button>
      </div>

      <div className="card overflow-hidden">
        {!data ? (
          <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : data.checks.length === 0 ? (
          <EmptyState icon="🛡️" title="No verifications logged"
            hint="Log your first eligibility check — portal, phone, or clearinghouse."
            action={canWrite ? <button className="btn btn-primary" onClick={() => setModal('new')}>+ Log check</button> : null} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl min-w-[860px]">
              <thead><tr><th>Patient</th><th>Payer</th><th>Service date</th><th>Status</th><th>Verified via</th><th>Copay</th><th>Checked by</th>{canWrite && <th className="!text-right">Actions</th>}</tr></thead>
              <tbody>
                {data.checks.map((c) => (
                  <tr key={c.id}>
                    <td className="font-semibold text-slate-900">{c.patient_name}</td>
                    <td className="text-slate-600">{c.payer_name || '—'}</td>
                    <td className="text-slate-600 text-[13px]">{c.service_date || '—'}</td>
                    <td><span className={`badge ${STATUS_META[c.coverage_status].cls}`}>{STATUS_META[c.coverage_status].label}</span></td>
                    <td className="text-slate-600 text-[13px] capitalize">{c.verified_via || '—'}</td>
                    <td className="text-slate-600 text-[13px]">{c.copay != null ? `$${Number(c.copay).toFixed(2)}` : '—'}</td>
                    <td className="text-slate-500 text-[13px]">{c.checked_by_name || '—'}</td>
                    {canWrite && (
                      <td className="!text-right">
                        <div className="flex gap-3 justify-end">
                          <button onClick={() => setModal(c)} className="text-sky-600 hover:text-sky-800 text-xs font-semibold">Edit</button>
                          <button onClick={() => remove(c.id, c.patient_name)} className="text-rose-600 hover:text-rose-800 text-xs font-semibold">Delete</button>
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
