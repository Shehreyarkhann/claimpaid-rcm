export default function Layout({ page, setPage, children }) {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'claims', label: 'Claims' },
  ];
  return (
    <div className="min-h-screen">
      <header className="bg-ink text-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-ink">P</div>
            <div>
              <div className="font-bold text-lg leading-tight">ClaimPilot RCM</div>
              <div className="text-xs text-slate-400">Revenue Cycle Analytics</div>
            </div>
          </div>
          <nav className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setPage(t.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  page === t.id
                    ? 'bg-emerald-500 text-ink'
                    : 'text-slate-300 hover:bg-white/10'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
      <footer className="max-w-7xl mx-auto px-4 pb-8 text-xs text-slate-400">
        Demo data — 600 synthetic claims. Built with React, Node.js, SQLite.
      </footer>
    </div>
  );
}
