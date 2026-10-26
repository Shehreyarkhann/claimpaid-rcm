import { useState, useEffect } from 'react';
import { useAuth } from '../auth';
import UserMenu from './UserMenu';
import { useOrgSettings } from '../orgSettings';
import { api } from '../api';
import WorkspaceSwitcher from './WorkspaceSwitcher';

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
  billing: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>
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
  ai: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9h.01M15 9h.01M9 13a3 3 0 0 0 3 3 3 3 0 0 0 3-3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
    </svg>
  ),
  org: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-4h6v4"/>
    </svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
    </svg>
  ),
  ehr: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  ),
};

function useIsDesktop() {
  const [d, setD] = useState(() => {
    try { return window.matchMedia('(min-width: 1024px)').matches; } catch { return true; }
  });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia('(min-width: 1024px)'); } catch { return undefined; }
    if (!mq || !mq.addEventListener) return undefined;
    const fn = (e) => setD(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return d;
}

const MENU_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6h16M4 12h16M4 18h16"/>
  </svg>
);

export default function Shell({ page, setPage, children, dueCount, authzAlertCount }) {
  const { user, logout } = useAuth();
  const { settings } = useOrgSettings() || {};
  const isDesktop = useIsDesktop();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('cp_sidebar') === 'collapsed'; } catch { return false; }
  });
  // Icon rail applies on desktop only; the mobile drawer is always full-width.
  const rail = collapsed && isDesktop;
  const [baaSigned, setBaaSigned] = useState(null);
  // Plan usage warning (owners): banner when any metered resource is ≥80% of quota
  const [usageWarn, setUsageWarn] = useState(null);
  useEffect(() => {
    if (user?.role === 'owner') {
      api.billingUsage().then((u) => {
        if (!u?.warn?.length) return;
        const pick = ['claims', 'seats', 'aiQueries'].find((k) => u.warn.includes(k));
        const res = u[pick];
        if (res && res.limit !== null && res.limit !== undefined) {
          const noun = pick === 'claims' ? 'claims' : pick === 'seats' ? 'team seats' : 'AI queries';
          setUsageWarn(`You've used ${Number(res.used).toLocaleString('en-US')} of ${Number(res.limit).toLocaleString('en-US')} ${noun} this month — upgrade to avoid interruption.`);
        }
      }).catch(() => {});
    } else {
      setUsageWarn(null);
    }
  }, [user?.role]);
  // Owners get a persistent nudge until the BAA is signed
  useEffect(() => {
    if (user?.role === 'owner') {
      api.baaStatus().then((s) => setBaaSigned(!!s.signed)).catch(() => setBaaSigned(true));
    } else {
      setBaaSigned(true);
    }
  }, [user?.role]);
  const toggle = () => {
    setCollapsed((c) => {
      try { localStorage.setItem('cp_sidebar', c ? 'open' : 'collapsed'); } catch {}
      return !c;
    });
  };

  const tabs = [
    { id: 'work', label: 'My Work', icon: ICONS.work, badge: dueCount },
    { id: 'digest', label: 'Daily Briefing', icon: ICONS.digest },
    { id: 'dashboard', label: 'Dashboard', icon: ICONS.dashboard },
    { id: 'claims', label: 'Claims', icon: ICONS.claims },
    { id: 'denials', label: 'Denial Appeals', icon: ICONS.denials },
    { id: 'authz', label: 'Authorizations', icon: ICONS.authz, badge: authzAlertCount },
    { id: 'elig', label: 'Eligibility', icon: ICONS.elig },
    { id: 'transmit', label: 'Transmission', icon: ICONS.send || ICONS.elig },
    { id: 'era', label: 'ERA Posting', icon: ICONS.reports },
    { id: 'statements', label: 'Patient Statements', icon: ICONS.reports },
    { id: 'ehr', label: 'EHR', icon: ICONS.ehr },
    { id: 'reports', label: 'Reports', icon: ICONS.reports },
    { id: 'playbook', label: 'Playbook', icon: ICONS.playbook },
    { id: 'ai', label: 'AI Assistant', icon: ICONS.ai },
  ];
  const settingsTabs = [
    { id: 'org', label: 'Organization', icon: ICONS.org },
    { id: 'filing', label: 'Filing Rules', icon: ICONS.filing },
    ...(['owner', 'biller'].includes(user?.role) ? [{ id: 'letters', label: 'Letter Templates', icon: ICONS.letter }] : []),
    ...(user?.role === 'owner' ? [{ id: 'team', label: 'Team', icon: ICONS.team }] : []),
    ...(user?.role === 'owner' ? [{ id: 'audit', label: 'Audit Log', icon: ICONS.audit }] : []),
    ...(user?.role === 'owner' ? [{ id: 'compliance', label: 'Compliance', icon: ICONS.shield }] : []),
    ...(user?.role === 'owner' ? [{ id: 'billing', label: 'Billing & Plan', icon: ICONS.billing }] : []),
  ];

  const settingsIds = new Set(settingsTabs.map((t) => t.id));
  // Settings section is closed by default; it opens itself when the user is
  // on (or lands on) a settings page so the active item is never hidden.
  useEffect(() => { if (settingsIds.has(page)) setSettingsOpen(true); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => { setPage(id); setMobileOpen(false); };
  const allTabs = [...tabs, ...settingsTabs];
  const currentLabel = allTabs.find((t) => t.id === page)?.label || 'ClaimPaid';
  const bottomTabs = [
    tabs.find((t) => t.id === 'work'),
    tabs.find((t) => t.id === 'dashboard'),
    tabs.find((t) => t.id === 'claims'),
    tabs.find((t) => t.id === 'ehr'),
  ].filter(Boolean);

  const initials = (user?.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const navItem = (t) => (
    <button key={t.id} onClick={() => go(t.id)} title={rail ? t.label : undefined}
      className={`nav-link w-full relative ${page === t.id ? 'active' : ''} ${rail ? '!px-0 justify-center' : ''}`}>
      {t.icon}
      {!rail && <span className="flex-1 text-left">{t.label}</span>}
      {t.badge > 0 && (
        <span className={`bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center ${rail ? 'absolute ml-7 mb-5 !px-1 !min-w-[16px]' : ''}`}>{t.badge}</span>
      )}
    </button>
  );

  return (
    <div className="min-h-screen flex">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-stone-900/60 z-40 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      {/* Sidebar — off-canvas drawer below lg, fixed rail/bar on desktop */}
      <aside className={`${rail ? 'w-[76px]' : 'w-[248px]'} shrink-0 bg-[#17251F] text-white flex flex-col fixed inset-y-0 left-0 z-50 transition-all duration-200 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        <div className={`${rail ? 'px-4' : 'px-5'} pt-6 pb-2`}>
          <div className={`flex items-center ${rail ? 'justify-center' : 'gap-3'}`}>
            {settings?.logo_url ? (
              <img src={settings.logo_url} alt="Workspace logo" className="w-10 h-10 rounded-xl object-contain bg-white shrink-0" />
            ) : (
              <button onClick={() => go('work')} title="ClaimPaid home" className="shrink-0 rounded-xl transition hover:opacity-90"><img src="/app/claimpaid-icon.webp" alt="ClaimPaid" className="w-10 h-10 rounded-xl shadow-[0_4px_16px_rgba(16,185,129,0.4)]" /></button>
            )}
            {!rail && <WorkspaceSwitcher collapsed={rail} />}
            {!rail && (
              <button onClick={() => setMobileOpen(false)} title="Close menu"
                className="lg:hidden ml-auto text-stone-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overflow-x-hidden">
          {!rail && <div className="px-3.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-stone-500">Workspace</div>}
          {tabs.map(navItem)}
          {rail ? (
            <>
              <div className="mx-2 my-2 border-t border-white/10" />
              {settingsTabs.map(navItem)}
            </>
          ) : (
            <>
              <button onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}
                className="w-full flex items-center px-3.5 pt-4 pb-2 group">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 group-hover:text-stone-300 transition flex-1 text-left">Settings</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`text-stone-500 group-hover:text-stone-300 transition-transform duration-200 ${settingsOpen ? 'rotate-180' : ''}`}>
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
              {settingsOpen && settingsTabs.map(navItem)}
            </>
          )}
        </nav>

        <div className="p-3 space-y-2">
          <button onClick={toggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-full hidden lg:flex items-center justify-center gap-2 rounded-xl bg-white/5 hover:bg-white/10 transition p-2.5 text-stone-400 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}>
              <path d="M15 18l-6-6 6-6"/>
            </svg>
            {!rail && <span className="text-xs font-medium">Collapse</span>}
          </button>
          <div className="rounded-xl bg-white/5 p-3">
            <UserMenu placement="up" rail={rail} />
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className={`flex-1 ml-0 ${rail ? 'lg:ml-[76px]' : 'lg:ml-[248px]'} min-h-screen flex flex-col transition-all duration-200 min-w-0`}>
        {/* Mobile top bar */}
        <div className="lg:hidden sticky top-0 z-30 bg-[#17251F] text-white px-4 py-3 flex items-center gap-3 shadow-md">
          <button onClick={() => setMobileOpen(true)} title="Open menu" className="p-1.5 -ml-1.5 rounded-lg hover:bg-white/10 transition">
            {MENU_ICON}
          </button>
          <button onClick={() => go('work')} title="ClaimPaid home" className="shrink-0 rounded-lg transition hover:opacity-90"><img src={settings?.logo_url || '/app/claimpaid-icon.webp'} alt="ClaimPaid" className="w-8 h-8 rounded-lg object-contain bg-white/10" /></button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">{currentLabel}</div>
            <div className="text-[11px] text-stone-400 leading-tight truncate">{user?.org_name || 'ClaimPaid'}</div>
          </div>
          <UserMenu placement="down" compact />
        </div>
        {usageWarn && (
          <button onClick={() => setPage('billing')}
            className="mx-4 lg:mx-8 mt-4 lg:mt-5 rounded-xl bg-amber-50 border border-amber-300 px-5 py-3 flex items-center gap-3 text-left hover:bg-amber-100 transition max-w-[1400px] w-[calc(100%-2rem)] lg:w-[calc(100%-4rem)] self-center">
            <span className="text-amber-700 text-lg">📊</span>
            <span className="text-sm text-amber-900">
              <strong>Plan usage:</strong> {usageWarn}
              <span className="underline font-medium ml-1">Go to Billing →</span>
            </span>
          </button>
        )}
        {baaSigned === false && (
          <button onClick={() => setPage('compliance')}
            className="mx-4 lg:mx-8 mt-4 lg:mt-5 rounded-xl bg-amber-50 border border-amber-300 px-5 py-3 flex items-center gap-3 text-left hover:bg-amber-100 transition max-w-[1400px] w-[calc(100%-2rem)] lg:w-[calc(100%-4rem)] self-center">
            <span className="text-amber-600 text-lg">⚠</span>
            <span className="text-sm text-amber-900">
              <strong>HIPAA compliance:</strong> sign your Business Associate Agreement to activate a paid plan and process PHI.
              <span className="underline font-medium ml-1">Go to Compliance →</span>
            </span>
          </button>
        )}
        <main className="flex-1 px-4 pt-5 pb-24 sm:px-6 lg:px-8 lg:py-7 max-w-[1400px] w-full mx-auto">
          {children}
        </main>
        <footer className="px-4 sm:px-6 lg:px-8 pb-24 lg:pb-6 text-xs text-stone-400 max-w-[1400px] w-full mx-auto flex flex-col sm:flex-row gap-2 justify-between sm:items-center">
          <span>ClaimPaid RCM · Your data is isolated to your organization</span>
          <span>Part of <a href="https://claimpaid.io" target="_blank" rel="noreferrer" className="text-emerald-600 font-semibold hover:underline">ClaimPaid</a> · <a href="/legal/terms" className="text-stone-500 hover:text-stone-700 hover:underline">Terms</a> · <a href="/legal/privacy" className="text-stone-500 hover:text-stone-700 hover:underline">Privacy</a> · <a href="/support" className="text-stone-500 hover:text-stone-700 hover:underline">Support</a> · <a href="/ai/app/" className="text-amber-700 font-semibold hover:underline">ClaimPaid AI</a></span>
        </footer>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#17251F]/95 backdrop-blur border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-5">
          {bottomTabs.map((t) => (
            <button key={t.id} onClick={() => go(t.id)}
              className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition ${page === t.id ? 'text-emerald-400' : 'text-stone-400'}`}>
              {t.icon}
              <span>{t.label === 'My Work' ? 'Work' : t.label}</span>
              {t.badge > 0 && (
                <span className="absolute top-1 right-1/2 translate-x-4 bg-rose-500 text-white text-[9px] font-bold px-1 py-px rounded-full min-w-[16px] text-center">{t.badge}</span>
              )}
            </button>
          ))}
          <button onClick={() => setMobileOpen(true)}
            className="flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium text-stone-400 transition">
            {MENU_ICON}
            <span>Menu</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
