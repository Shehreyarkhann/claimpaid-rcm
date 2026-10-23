import { useEffect, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

const CAT_COLORS = {
  billing: 'badge-blue', appeals: 'badge-amber', auth: 'badge-violet',
  contact: 'badge-green', general: 'badge-slate',
};

function EntryModal({ entry, payers, categories, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(entry ? {
    title: entry.title, content: entry.content,
    category: entry.category, payer_id: entry.payer_id || '',
  } : { title: '', content: '', category: 'general', payer_id: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const payload = { ...form, payer_id: form.payer_id ? Number(form.payer_id) : null };
      const res = await authFetch(entry ? `/api/playbook/${entry.id}` : '/api/playbook', {
        method: entry ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success(entry ? 'Entry updated' : 'Entry added to playbook');
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-5">{entry ? 'Edit entry' : 'Add to playbook'}</h3>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="grid sm:grid-cols-3 gap-4 mb-4">
          <div className="sm:col-span-2"><label className="label">Title</label>
            <input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Aetna requires modifier 25 on 99213" /></div>
          <div><label className="label">Category</label>
            <select className="input" value={form.category} onChange={set('category')}>
              {Object.entries(categories).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
        </div>
        <div className="mb-4"><label className="label">Payer (optional — leave blank for all payers)</label>
          <select className="input" value={form.payer_id} onChange={set('payer_id')}>
            <option value="">All payers</option>
            {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div className="mb-5"><label className="label">Details</label>
          <textarea className="input min-h-[140px]" value={form.content} onChange={set('content')}
            placeholder="What does the team need to know? Phone numbers, fax numbers, portal URLs, quirks, workarounds…" /></div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : entry ? 'Save changes' : 'Add entry'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Playbook() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [payers, setPayers] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [payer, setPayer] = useState('');
  const [modal, setModal] = useState(null);
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const load = () => api.playbook({ search, category, payer }).then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { api.payers().then(setPayers).catch(() => {}); }, []);
  useEffect(() => { load(); api.payerStats().then(setStats).catch(() => {}); }, []);

  const applyFilters = () => load();

  const remove = async (id, title) => {
    if (!window.confirm(`Delete "${title}"?`)) return;
    try {
      const res = await authFetch(`/api/playbook/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Entry deleted');
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      {modal && <EntryModal entry={modal === 'add' ? null : modal} payers={payers}
        categories={data?.categories || {}} onClose={() => setModal(null)}
        onSaved={() => { setModal(null); load(); }} />}

      <PageHeader
        title="Payer Playbook"
        subtitle="Your team's shared brain — payer quirks, contacts, and workarounds that used to live in someone's head"
        actions={canWrite ? [<button key="a" className="btn btn-primary" onClick={() => setModal('add')}>+ Add entry</button>] : []}
      />

      <div className="card p-4 flex flex-wrap gap-3 items-end mb-5">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
            placeholder="Search titles and content…" className="input" />
        </div>
        <div><label className="label">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {data && Object.entries(data.categories).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        <div><label className="label">Payer</label>
          <select value={payer} onChange={(e) => setPayer(e.target.value)} className="input !w-auto">
            <option value="">All</option>
            {payers.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></div>
        <button onClick={applyFilters} className="btn btn-dark">Filter</button>
      </div>

      {!data ? (
        <div className="grid md:grid-cols-2 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : (
        <>
          {stats && stats.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-2.5 mb-3">
                <h3 className="font-semibold text-slate-900 tracking-tight">Payer performance</h3>
                <span className="badge badge-green">From your data</span>
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full tbl">
                    <thead><tr>
                      <th>Payer</th><th className="!text-right">Claims</th><th className="!text-right">Denial rate</th>
                      <th>Top denial reasons</th><th className="!text-right">Avg days in A/R</th><th className="!text-right">Paid w/o appeal</th>
                    </tr></thead>
                    <tbody>
                      {stats.map((s) => (
                        <tr key={s.id}>
                          <td className="font-medium whitespace-nowrap">{s.name}</td>
                          <td className="!text-right text-slate-500">{s.total_claims}</td>
                          <td className="!text-right">
                            <span className={`badge ${s.denial_rate >= 20 ? 'badge-rose' : s.denial_rate >= 10 ? 'badge-amber' : 'badge-green'}`}>
                              {s.denial_rate}%
                            </span>
                          </td>
                          <td className="text-xs text-slate-500 max-w-[260px]">
                            {s.top_denial_reasons.length === 0 ? (
                              <span className="text-slate-300">—</span>
                            ) : (
                              <ul className="space-y-0.5">
                                {s.top_denial_reasons.map((r) => (
                                  <li key={r.denial_reason} className="truncate" title={`${r.denial_reason} (${r.n})`}>
                                    {r.denial_reason} <span className="text-slate-400">({r.n})</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="!text-right text-slate-500">{s.avg_ar_days ?? '—'}</td>
                          <td className="!text-right text-slate-500">{s.first_pass_rate != null ? `${s.first_pass_rate}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2.5 mb-3">
            <h3 className="font-semibold text-slate-900 tracking-tight">Team notes</h3>
            <span className="badge badge-slate">Manual entries</span>
          </div>
          {data.entries.length === 0 ? (
            <div className="card">
              <EmptyState icon="📖" title="Playbook is empty"
                hint="Capture the first piece of tribal knowledge — a payer phone number, an appeal fax, a coding quirk. Future you will thank present you."
                action={canWrite ? <button className="btn btn-primary" onClick={() => setModal('add')}>+ Add first entry</button> : null} />
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {data.entries.map((e) => (
                <div key={e.id} className="card p-5 hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`badge ${CAT_COLORS[e.category]}`}>{data.categories[e.category]}</span>
                      {e.payer_name && <span className="badge badge-slate">{e.payer_name}</span>}
                    </div>
                    {canWrite && (
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => setModal(e)} className="text-sky-600 hover:text-sky-800 text-xs font-semibold">Edit</button>
                        <button onClick={() => remove(e.id, e.title)} className="text-rose-600 hover:text-rose-800 text-xs font-semibold">Delete</button>
                      </div>
                    )}
                  </div>
                  <div className="font-semibold text-slate-900 mb-1.5">{e.title}</div>
                  <div className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed">{e.content}</div>
                  <div className="text-[11px] text-slate-400 mt-3">
                    {e.author ? `Added by ${e.author} · ` : ''}{new Date(e.updated_at).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
