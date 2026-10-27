import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar';
import AccountModal from './AccountModal';
import { useAuth } from '../auth';
import { api } from '../api';
import { useToast } from './ui';

// Profile-picture menu (deploy #57): the professional account dropdown —
// header with identity, profile/security shortcuts, log out everywhere,
// log out. `placement` = 'up' (sidebar footer) or 'down' (mobile top bar).
// In rail (collapsed) mode the click expands the sidebar (via onExpand)
// and opens the account modal directly; the modal itself is portaled to
// the app root by ui.jsx, so it is never clipped by the sidebar.
export default function UserMenu({ placement = 'up', rail = false, compact = false, onExpand = null }) {
  const avatarOnly = rail || compact;
  const { user, logout, adoptToken } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // 'profile' | 'security'
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open ]);

  if (!user) return null;

  const openModal = (tabName) => { setOpen(false); setModal(tabName); };
  const logoutEverywhere = async () => {
    setOpen(false);
    try {
      const r = await api.logoutAll();
      adoptToken(r.token);
      toast.success('Signed out on all other devices');
    } catch (e) { toast.error(e.message); }
  };

  const item = 'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-stone-300 hover:bg-white/10 hover:text-white rounded-lg transition text-left';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          if (rail) { onExpand?.(); setModal('profile'); }
          else setOpen((o) => !o);
        }}
        title="Account"
        className={`flex items-center ${avatarOnly ? 'justify-center' : 'gap-3 w-full'} rounded-xl hover:bg-white/5 transition p-1 -m-1`}
      >
        <Avatar userId={user.id} name={user.name} hasAvatar={user.has_avatar} className="w-9 h-9 text-xs" />
        {!avatarOnly && (
          <>
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-sm font-medium truncate text-white">{user.name}</span>
              <span className="block text-[11px] text-stone-400 capitalize truncate">{user.title || user.role}</span>
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`text-stone-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </>
        )}
      </button>

      {open && !rail && (
        <div className={`absolute ${placement === 'up' ? 'bottom-full mb-2 left-0' : 'top-full mt-2 right-0'} w-64 max-w-[calc(100vw-2rem)] bg-[#1D2E26] border border-white/10 rounded-2xl shadow-2xl p-2 z-[60]`}>
          <div className="flex items-center gap-3 px-3 py-3 border-b border-white/10 mb-1">
            <Avatar userId={user.id} name={user.name} hasAvatar={user.has_avatar} className="w-10 h-10 text-sm" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white truncate">{user.name}</div>
              <div className="text-xs text-stone-400 truncate">{user.email}</div>
            </div>
          </div>
          <button className={item} onClick={() => openModal('profile')}>
            <span>👤</span> Edit profile & photo
          </button>
          <button className={item} onClick={() => openModal('security')}>
            <span>🔒</span> Password & sessions
          </button>
          <div className="border-t border-white/10 mt-1 pt-1">
            <button className={item} onClick={logoutEverywhere}>
              <span>🚪</span> Log out of all other devices
            </button>
            <button className={`${item} !text-rose-300 hover:!bg-rose-500/10`} onClick={() => { setOpen(false); logout(); }}>
              <span>⏻</span> Log out
            </button>
          </div>
        </div>
      )}

      {modal && <AccountModal initialTab={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
