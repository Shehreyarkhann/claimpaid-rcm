import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

// Notification center (Deploy #101, WS-D). The panel unifies DERIVED
// items — pending approvals, due follow-ups, payer-silent submissions,
// held ERA remittances, auto-approved drafts awaiting review — computed
// live on the server from real workspace state. Read state is a
// per-user watermark: opening the panel marks everything shown as
// read. If the endpoint fails (agent disabled), the bell hides itself.

const CATEGORY_LABEL = {
  approval: 'Approval waiting',
  followup: 'Follow-up due',
  payer_silent: 'Payer silent',
  era_held: 'ERA on hold',
  auto_approved: 'Auto-approved',
};

function whenText(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function NotificationBell({ onNavigate, variant = 'sidebar', collapsed = false }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(() => {
    api.agent.notifications()
      .then((d) => { setData(d); })
      .catch(() => setHidden(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [user, load]);

  const toggle = () => {
    if (!open) {
      setOpen(true);
      api.agent.markNotificationsRead()
        .then(() => setData((d) => (d ? { ...d, unread_count: 0 } : d)))
        .catch(() => {});
    } else {
      setOpen(false);
    }
  };

  const goItem = (item) => {
    setOpen(false);
    if (item.target && item.target.page && onNavigate) onNavigate(item.target.page);
  };

  const setDigest = async (checked) => {
    const optOut = !checked;
    try {
      const r = await api.agent.digestPref(optOut);
      setData((d) => (d ? { ...d, digest_opt_out: r.digest_opt_out } : d));
    } catch { /* keep the old state */ }
  };

  if (hidden || !data) return null;
  const unread = data.unread_count || 0;

  return (
    <div className="relative" data-testid="notification-bell">
      <button type="button" onClick={toggle}
        aria-label={unread > 0 ? `Notifications — ${unread} unread` : 'Notifications'}
        title="Notifications"
        className={`relative flex items-center gap-2 w-full rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2 text-[13px] text-stone-300 transition ${collapsed ? 'justify-center' : ''}`}>
        <span className="text-base leading-none">🔔</span>
        {!collapsed && <span className="flex-1 text-left">Notifications</span>}
        {unread > 0 && (
          <span className="min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      {open && (
        <div className={`absolute z-50 w-[340px] max-w-[92vw] rounded-2xl bg-white text-stone-800 shadow-2xl border border-stone-200 overflow-hidden ${variant === 'mobile' ? 'right-0 top-[calc(100%+8px)]' : 'left-0 bottom-[calc(100%+8px)]'}`}>
          <div className="px-4 py-3 border-b border-stone-100 flex items-baseline gap-2">
            <span className="font-semibold text-stone-900">Notifications</span>
            <span className="text-xs text-stone-400">Derived from your workspace, live</span>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            {(!data.items || data.items.length === 0) ? (
              <div className="px-4 py-6 text-sm text-stone-400 text-center">All clear — nothing needs you right now.</div>
            ) : data.items.map((item, i) => (
              <button key={`${item.category}-${item.ref_id || i}`} type="button" onClick={() => goItem(item)}
                className="w-full text-left px-4 py-3 border-b border-stone-50 hover:bg-stone-50 transition">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">{CATEGORY_LABEL[item.category] || item.category}</span>
                  <span className="text-[11px] text-stone-400 ml-auto">{whenText(item.ts)}</span>
                </div>
                <div className="text-[13px] font-medium text-stone-800 mt-0.5">{item.title}</div>
                {item.detail && <div className="text-xs text-stone-500">{item.detail}</div>}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 px-4 py-3 bg-stone-50 text-xs text-stone-600 cursor-pointer">
            <input type="checkbox" className="accent-emerald-600" checked={!data.digest_opt_out}
              onChange={(e) => setDigest(e.target.checked)} />
            Email me the morning digest (counts only, never patient details)
          </label>
        </div>
      )}
    </div>
  );
}
