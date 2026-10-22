import { useAuth } from '../auth';

const ICONS = {
  work: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
      <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
    </svg>
  ),
  claims: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>
    </svg>
  ),
  denials: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
    </svg>
  ),
  team: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  filing: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  ),
  reports: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-8"/>
    </svg>
  ),
  playbook: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  ),
  digest: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>
    </svg>
  ),
  authz: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  elig: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
    </svg>
  ),
  audit: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>
    </svg>
  ),
  letter: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>
    </svg>
  ),
};

export default function Shell({ page, setPage, children, dueCount, authzAlertCount }) {
  const { user, logout } = useAuth();

  const tabs = [
    { id: 'work', label: 'My Work', icon: ICONS.work, badge: dueCount },
    { id: 'digest', label: 'Daily Briefing', icon: ICONS.digest },
    { id: 'dashboard', label: 'Dashboard', icon: ICONS.dashboard },
    { id: 'claims', label: 'Claims', icon: ICONS.claims },
    { id: 'denials', label: 'Denial Appeals', icon: ICONS.denials },
    { id: 'authz', label: 'Authorizations', icon: ICONS.authz, badge: authzAlertCount },
    { id: 'elig', label: 'Eligibility', icon: ICONS.elig },
    { id: 'reports', label: 'Reports', icon: ICONS.reports },
    { id: 'playbook', label: 'Playbook', icon: ICONS.playbook },
  ];
  const settingsTabs = [
    { id: 'filing', label: 'Filing Rules', icon: ICONS.filing },
    ...(['owner', 'biller'].includes(user?.role) ? [{ id: 'letters', label: 'Letter Templates', icon: ICONS.letter }] : []),
    ...(user?.role === 'owner' ? [{ id: 'team', label: 'Team', icon: ICONS.team }] : []),
    ...(user?.role === 'owner' ? [{ id: 'audit', label: 'Audit Log', icon: ICONS.audit }] : []),
  ];

  const initials = (user?.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[248px] shrink-0 bg-[#0b1220] text-white flex flex-col fixed inset-y-0 z-40">
        <div className="px-5 pt-6 pb-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#0b1220] text-lg shadow-[0_4px_16px_rgba(16,185,129,0.4)]">P</div>
            <div>
              <div className="font-bold leading-tight tracking-tight">ClaimPilot RCM</div>
              <div className="text-[11px] text-slate-400 truncate max-w-[150px]">{user?.orgName}</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <div className="px-3.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Workspace</div>
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setPage(t.id)}
              className={`nav-link w-full ${page === t.id ? 'active' : ''}`}>
              {t.icon}
              <span className="flex-1 text-left">{t.label}</span>
              {t.badge > 0 && (
                <span className="bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">{t.badge}</span>
              )}
            </button>
          ))}
          <div className="px-3.5 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Settings</div>
          {settingsTabs.map((t) => (
            <button key={t.id} onClick={() => setPage(t.id)}
              className={`nav-link w-full ${page === t.id ? 'active' : ''}`}>
              {t.icon}
              <span className="flex-1 text-left">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-3">
          <div className="rounded-xl bg-white/5 p-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-sky-500 flex items-center justify-center text-xs font-bold text-white shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user?.name}</div>
              <div className="text-[11px] text-slate-400 capitalize">{user?.role}</div>
            </div>
            <button onClick={logout} title="Sign out"
              className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 ml-[248px] min-h-screen flex flex-col">
        <main className="flex-1 px-8 py-7 max-w-[1400px] w-full mx-auto">
          {children}
        </main>
        <footer className="px-8 pb-6 text-xs text-slate-400 max-w-[1400px] w-full mx-auto flex justify-between items-center">
          <span>ClaimPilot RCM · Your data is isolated to your organization</span>
          <span>Part of <a href="https://claimpilot.io" target="_blank" rel="noreferrer" className="text-emerald-600 font-semibold hover:underline">ClaimPilot</a> · <a href="#" onClick={(e) => e.preventDefault()} title="Ask your payer policies anything" className="text-violet-600 font-semibold hover:underline">🤖 ClaimPilot AI</a></span>
        </footer>
      </div>
    </div>
  );
}
