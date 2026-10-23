import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

// DB stores UTC as 'YYYY-MM-DD HH:MM:SS' — parse as UTC explicitly.
const asUtc = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);

export function SlaBadge({ ticket }) {
  if (!ticket || ticket.status === 'closed' || !ticket.sla_due_at) return null;
  const due = asUtc(ticket.sla_due_at);
  const now = new Date();
  const hrs = (due - now) / 3600000;
  if (hrs < 0)
    return <span className="badge !bg-rose-500/15 !text-rose-300 !border-rose-500/30">OVERDUE</span>;
  if (hrs < 4)
    return <span className="badge !bg-amber-500/15 !text-amber-300 !border-amber-500/30">Due in {Math.max(1, Math.round(hrs))}h</span>;
  return <span className="text-xs text-slate-500">Due {due.toLocaleDateString()}</span>;
}

const STATUS_STYLE = {
  open: 'badge-amber',
  pending: 'badge !bg-sky-500/15 !text-sky-300 !border-sky-500/30',
  closed: 'badge-green',
};

function ThreadView({ ticketId, onBack }) {
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = () => api.support.thread(ticketId).then(setData).catch((e) => setError(e.message));
  useEffect(load, [ticketId]);

  const send = async () => {
    if (!reply.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await api.support.reply(ticketId, reply.trim());
      setReply('');
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (error && !data) return <div className="text-rose-300 text-sm">{error}</div>;
  if (!data) return <div className="text-slate-500 text-sm">Loading…</div>;
  const { ticket, replies } = data;

  return (
    <div>
      <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 mb-4">← All tickets</button>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <span className={`badge ${STATUS_STYLE[ticket.status] || 'badge-amber'}`}>{ticket.status}</span>
        <SlaBadge ticket={ticket} />
        <span className="text-xs text-slate-500">#{ticket.id} · opened {ticket.created_at?.slice(0, 16).replace('T', ' ')}</span>
      </div>
      <h2 className="text-lg font-bold text-white mb-5">{ticket.subject}</h2>

      <div className="space-y-3 mb-6">
        <div className="flex justify-end">
          <div className="max-w-[85%] bg-emerald-600/20 border border-emerald-500/30 rounded-2xl rounded-br-md px-4 py-3">
            <div className="text-[11px] text-emerald-300/70 mb-1">You</div>
            <div className="text-sm text-slate-100 whitespace-pre-wrap">{ticket.message}</div>
          </div>
        </div>
        {replies.map((r) => r.author_type === 'staff' ? (
          <div key={r.id} className="flex justify-start">
            <div className="max-w-[85%] bg-slate-800 border border-slate-700 rounded-2xl rounded-bl-md px-4 py-3">
              <div className="text-[11px] text-slate-500 mb-1">Support · {r.created_at?.slice(0, 16).replace('T', ' ')}</div>
              <div className="text-sm text-slate-100 whitespace-pre-wrap">{r.body}</div>
            </div>
          </div>
        ) : (
          <div key={r.id} className="flex justify-end">
            <div className="max-w-[85%] bg-emerald-600/20 border border-emerald-500/30 rounded-2xl rounded-br-md px-4 py-3">
              <div className="text-[11px] text-emerald-300/70 mb-1">You · {r.created_at?.slice(0, 16).replace('T', ' ')}</div>
              <div className="text-sm text-slate-100 whitespace-pre-wrap">{r.body}</div>
            </div>
          </div>
        ))}
      </div>

      {ticket.status === 'closed' ? (
        <div className="text-sm text-slate-500 bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3">
          This ticket is closed. Open a new ticket if you still need help.
        </div>
      ) : (
        <div>
          {error && <div className="mb-3 text-sm text-rose-300 bg-rose-950/60 border border-rose-800 rounded-xl px-4 py-3">{error}</div>}
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3}
            placeholder="Write your reply…" className="input !bg-slate-800 !border-slate-700 !text-white mb-3" />
          <button onClick={send} disabled={busy || !reply.trim()} className="btn btn-primary !py-2.5">
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      )}
    </div>
  );
}

function MyTickets() {
  const [tickets, setTickets] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { api.support.mine().then(setTickets).catch(() => setTickets([])); }, []);

  if (openId) return <ThreadView ticketId={openId} onBack={() => { setOpenId(null); api.support.mine().then(setTickets).catch(() => {}); }} />;
  if (!tickets) return <div className="text-slate-500 text-sm">Loading your tickets…</div>;
  if (tickets.length === 0)
    return <div className="text-sm text-slate-500 bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">No tickets yet — submit one below and we'll reply here.</div>;

  return (
    <div className="space-y-2 mb-2">
      {tickets.map((t) => (
        <button key={t.id} onClick={() => setOpenId(t.id)}
          className="w-full text-left bg-slate-900 border border-slate-800 rounded-2xl p-4 hover:border-slate-600 transition-colors">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`badge ${STATUS_STYLE[t.status] || 'badge-amber'}`}>{t.status}</span>
            <SlaBadge ticket={t} />
            {t.unread_staff_replies > 0 && (
              <span className="badge !bg-emerald-500 !text-[#0b1220] !border-emerald-500 font-bold">
                {t.unread_staff_replies} new repl{t.unread_staff_replies === 1 ? 'y' : 'ies'}
              </span>
            )}
            <span className="text-xs text-slate-500 ml-auto">#{t.id}</span>
          </div>
          <div className="text-sm font-medium text-white">{t.subject}</div>
          <div className="text-xs text-slate-500 mt-1">
            Updated {t.last_activity_at?.slice(0, 16).replace('T', ' ')} · {t.reply_count} repl{t.reply_count === 1 ? 'y' : 'ies'}
          </div>
        </button>
      ))}
    </div>
  );
}

function NewTicketForm({ onSubmitted }) {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '', website: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.submitSupport(form);
      setDone(true);
      onSubmitted && onSubmitted();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (done) return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
      <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xl mb-4">✓</div>
      <h2 className="text-lg font-bold text-white mb-2">Ticket received</h2>
      <p className="text-slate-400 text-sm">Thanks for reaching out — we'll get back to you shortly.</p>
    </div>
  );

  return (
    <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-2xl p-7">
      {error && <div className="mb-4 text-sm text-rose-300 bg-rose-950/60 border border-rose-800 rounded-xl px-4 py-3">{error}</div>}
      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <div><label className="label !text-slate-400">Name</label>
          <input value={form.name} onChange={set('name')} required placeholder="Jane Doe"
            className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
        <div><label className="label !text-slate-400">Email</label>
          <input type="email" value={form.email} onChange={set('email')} required placeholder="you@company.com"
            className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
      </div>
      <div className="mb-4"><label className="label !text-slate-400">Subject</label>
        <input value={form.subject} onChange={set('subject')} required placeholder="What do you need help with?"
          className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
      <div className="mb-5"><label className="label !text-slate-400">Message</label>
        <textarea value={form.message} onChange={set('message')} required rows={5}
          placeholder="Describe the issue…" className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
      {/* Honeypot — invisible to humans */}
      <input type="text" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off"
        style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0 }} aria-hidden="true" />
      <button type="submit" disabled={busy} className="btn btn-primary w-full !py-3">
        {busy ? 'Sending…' : 'Submit ticket'}
      </button>
    </form>
  );
}

export default function SupportPage() {
  const { user } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="min-h-screen bg-[#0b1220] flex items-start justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#0b1220] text-xl mb-4">C</div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Contact support</h1>
          <p className="text-slate-400 text-sm mt-2">We reply within one business day.</p>
        </div>

        {user ? (
          <div key={refreshKey}>
            <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-3">My tickets</h2>
            <div className="mb-8"><MyTickets /></div>
            <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-3">New ticket</h2>
            <NewTicketForm onSubmitted={() => setRefreshKey((k) => k + 1)} />
            <div className="text-center mt-4">
              <a href="/app/" className="text-xs text-slate-500 hover:text-slate-300">← Back to the app</a>
            </div>
          </div>
        ) : (
          <div>
            <NewTicketForm />
            <div className="text-center mt-4">
              <a href="/app/" className="text-xs text-slate-500 hover:text-slate-300">← Back to the app</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
