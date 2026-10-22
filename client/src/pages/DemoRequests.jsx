import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

export default function DemoRequests() {
  const toast = useToast();
  const [rows, setRows] = useState(null);

  const load = () => api.demoRequests().then(setRows).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const mark = async (id, contacted) => {
    try {
      await api.markDemoContacted(id, contacted);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : '—';

  return (
    <div>
      <PageHeader
        title="Demo Requests"
        subtitle="Leads from the landing page's Book a demo form. Follow up within one business day."
      />
      {!rows ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">📭</div>
          <div className="font-semibold text-slate-900">No demo requests yet</div>
          <p className="text-sm text-slate-500 mt-1">When someone clicks "Book a demo" on claimpaid.io, they'll show up here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.id} className={`card p-5 ${r.contacted ? 'opacity-70' : 'ring-1 ring-sky-200'}`}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-900">{r.name}</span>
                    {!r.contacted && <span className="badge badge-blue">NEW</span>}
                    {r.contacted && <span className="badge badge-slate">CONTACTED</span>}
                  </div>
                  <div className="text-sm text-slate-600 mt-1">
                    <span className="font-medium">{r.company}</span>
                    {r.team_size && <span className="text-slate-400"> · {r.team_size}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm">
                    <a className="text-sky-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a>
                    {r.phone && <a className="text-sky-600 hover:underline" href={`tel:${r.phone}`}>{r.phone}</a>}
                    <span className="text-slate-400 text-xs self-center">{fmtDate(r.created_at)}</span>
                  </div>
                  {r.message && (
                    <p className="mt-3 text-sm text-slate-700 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 whitespace-pre-wrap">{r.message}</p>
                  )}
                </div>
                <button
                  className={`btn ${r.contacted ? 'btn-ghost' : 'btn-primary'} !text-xs shrink-0`}
                  onClick={() => mark(r.id, !r.contacted)}
                >
                  {r.contacted ? 'Reopen' : 'Mark contacted ✓'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
