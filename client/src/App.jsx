import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider } from './components/ui';
import Shell from './components/Shell';
import FloatingChat from './components/FloatingChat';
import Dashboard from './pages/Dashboard';
import Claims from './pages/Claims';
import Denials from './pages/Denials';
import Team from './pages/Team';
import MyWork from './pages/MyWork';
import FilingRules from './pages/FilingRules';
import Reports from './pages/Reports';
import Playbook from './pages/Playbook';
import Digest from './pages/Digest';
import Authorizations from './pages/Authorizations';
import Eligibility from './pages/Eligibility';
import Transmission from './pages/Transmission';
import Ehr from './pages/Ehr';
import AuditLog from './pages/AuditLog';
import LetterTemplates from './pages/LetterTemplates';
import AIAssistant from './pages/AIAssistant';
import Billing from './pages/Billing';
import Organization from './pages/Organization';
import { Login, Signup, ForgotPassword, ResetPassword } from './pages/AuthPages';
import SuperAdmin from './pages/SuperAdmin';
import SupportPage from './pages/SupportPage';
import Legal from './pages/Legal';
import Compliance from './pages/Compliance';
import { api } from './api';
import ErrorBoundary from './components/ErrorBoundary';

function AuthGate({ children }) {
  const { user, loading } = useAuth();
  const [mode, setMode] = useState(() => {
    // Support /app/reset-password?token=... links from email
    const p = window.location.pathname;
    if (p.endsWith('/reset-password')) return 'reset';
    // Pricing CTAs land here: /app/?plan=starter|pro|ai -> start at signup
    if (new URLSearchParams(window.location.search).get('plan')) return 'signup';
    return 'login';
  });
  const [products, setProducts] = useState(null);

  useEffect(() => {
    if (user) {
      api.billingStatus()
        .then((s) => setProducts(s.products || { rcm: true, ai: true }))
        .catch(() => setProducts({ rcm: true, ai: true }));
    } else {
      setProducts(null);
    }
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b1220]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#0b1220] text-xl animate-pulse">P</div>
          <div className="text-slate-400 text-sm">Loading ClaimPaid RCM…</div>
        </div>
      </div>
    );
  }

  if (!user) {
    if (mode === 'reset') return <ResetPassword goLogin={() => { setMode('login'); window.history.replaceState({}, '', '/app/'); }} />;
    if (mode === 'forgot') return <ForgotPassword goLogin={() => setMode('login')} />;
    return mode === 'login'
      ? <Login goSignup={() => setMode('signup')} goForgot={() => setMode('forgot')} />
      : <Signup goLogin={() => setMode('login')} />;
  }

  // AI-only subscribers don't get the RCM dashboard — point them at the AI app
  if (products && products.rcm === false) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0b1220] px-6">
        <div className="max-w-md w-full text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-2xl mb-5">🤖</div>
          <h1 className="text-2xl font-bold text-white mb-2">You're on ClaimPaid AI</h1>
          <p className="text-slate-400 text-sm mb-6">
            Your subscription covers the AI assistant only. The RCM dashboard (claims, denials, appeals) isn't included in your plan.
          </p>
          <a href="/ai/app/" className="btn btn-primary w-full !py-3">Open ClaimPaid AI →</a>
        </div>
      </div>
    );
  }

  return children;
}

function Workspace() {
  // Trial intent from landing pricing (?plan=pro&trial=1) — pre-checks the trial toggle on Billing
  const [trialIntent] = useState(() => new URLSearchParams(window.location.search).get('trial') === '1');
  const [page, setPage] = useState(() => {
    // After landing-page pricing CTA signup (?plan=...), drop them on Billing
    const q = new URLSearchParams(window.location.search);
    const plan = q.get('plan');
    if (plan === 'starter' || plan === 'pro' || plan === 'ai') {
      window.history.replaceState({}, '', '/app/');
      return 'billing';
    }
    // Smart CTA for logged-in users without a plan (?billing=open)
    if (q.get('billing') === 'open') {
      window.history.replaceState({}, '', '/app/');
      return 'billing';
    }
    return 'work';
  });
  const [dueCount, setDueCount] = useState(0);
  const [authzAlertCount, setAuthzAlertCount] = useState(0);
  // Cross-page deep links: { page, appealId, claimId, startAppealClaimId }
  const [deepLink, setDeepLink] = useState(null);

  useEffect(() => {
    const refresh = () => {
      api.dueFollowups().then((d) => setDueCount(d.length)).catch(() => {});
      api.authzStats().then((s) => setAuthzAlertCount((s.expiringSoon || 0) + (s.expiredUnhandled || 0) + (s.byStatus?.pending_info || 0))).catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
  }, [page]);

  const go = (p, link = null) => { setDeepLink(link); setPage(p); };

  return (
    <>
    <Shell page={page} setPage={(p) => go(p)} dueCount={dueCount} authzAlertCount={authzAlertCount}>
      {/* ErrorBoundary resets per tab (key) so a crashing tab shows a
          recoverable card instead of blank-screening the whole app. */}
      <ErrorBoundary key={page} fallbackLabel="This tab">
      {page === 'work' && (
        <MyWork
          onOpenAppeal={(appealId) => go('denials', { appealId })}
          onOpenClaim={(claimId) => go('claims', { claimId })}
          onStartAppeal={(claimId) => go('denials', { startAppealClaimId: claimId })}
        />
      )}
      {page === 'digest' && <Digest />}
      {page === 'dashboard' && <Dashboard goDenials={() => go('denials')} />}
      {page === 'claims' && <Claims initialClaimId={deepLink?.claimId} onConsumed={() => setDeepLink(null)}
        onCheckEligibility={(claim) => go('elig', { prefill: { payerId: claim.payer_id, serviceDate: claim.service_date, patientName: claim.patient_name } })} />}
      {page === 'reports' && <Reports />}
      {page === 'playbook' && <Playbook />}
      {page === 'authz' && <Authorizations />}
      {page === 'elig' && <Eligibility initialPrefill={deepLink?.prefill} onConsumed={() => setDeepLink(null)} />}
      {page === 'transmit' && <Transmission />}
      {page === 'ehr' && <Ehr onViewClaim={(claimId) => go('claims', { claimId })} />}
      {page === 'audit' && <AuditLog />}
      {page === 'billing' && <Billing defaultTrial={trialIntent} onBaaRequired={() => go('compliance')} />}
      {page === 'org' && <Organization />}
      {page === 'compliance' && <Compliance />}
      {page === 'letters' && <LetterTemplates />}
      {page === 'denials' && (
        <Denials
          initialAppealId={deepLink?.appealId}
          initialStartAppealClaimId={deepLink?.startAppealClaimId}
          onConsumed={() => setDeepLink(null)}
        />
      )}
      {page === 'filing' && <FilingRules />}
      {page === 'team' && <Team />}
      {page === 'ai' && <AIAssistant />}
      </ErrorBoundary>
    </Shell>
    <FloatingChat />
    </>
  );
}


function SuperAdminGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="text-slate-500 text-sm">Loading…</div>
      </div>
    );
  }
  if (!user) {
    window.location.href = '/app/';
    return null;
  }
  if (!user.is_superadmin) {
    window.location.href = '/app/';
    return null;
  }
  return <SuperAdmin />;
}

export default function App() {
  const path = window.location.pathname;
  if (path === '/support') {
    return (
      <AuthProvider>
        <ToastProvider>
          <SupportPage />
        </ToastProvider>
      </AuthProvider>
    );
  }
  if (path === '/legal/terms') {
    return <Legal doc="terms" />;
  }
  if (path === '/legal/privacy') {
    return <Legal doc="privacy" />;
  }
  if (path === '/super' || path.startsWith('/super/')) {
    return (
      <AuthProvider>
        <ToastProvider>
          <SuperAdminGate />
        </ToastProvider>
      </AuthProvider>
    );
  }
  return (
    <AuthProvider>
      <ToastProvider>
        <AuthGate>
          <Workspace />
        </AuthGate>
      </ToastProvider>
    </AuthProvider>
  );
}
