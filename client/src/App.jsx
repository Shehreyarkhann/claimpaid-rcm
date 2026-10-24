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
import Era from './pages/Era';
import Ehr from './pages/Ehr';
import AuditLog from './pages/AuditLog';
import LetterTemplates from './pages/LetterTemplates';
import AIAssistant from './pages/AIAssistant';
import Billing from './pages/Billing';
import Organization from './pages/Organization';
import { Login, Signup, ForgotPassword, ResetPassword, OrgMfaRequiredScreen } from './pages/AuthPages';
import SuperAdmin from './pages/SuperAdmin';
import SupportPage from './pages/SupportPage';
import Legal from './pages/Legal';
import Compliance from './pages/Compliance';
import { api } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import LimitModal from './components/LimitModal';
import OnboardingWizard from './components/OnboardingWizard';
import { OrgSettingsProvider } from './orgSettings';

// Trial-expired owners land here: Billing handles reactivation,
// Compliance covers the BAA step if checkout demands it.
function ExpiredScreen() {
  const [view, setView] = useState('billing');
  return (
    <div className="min-h-screen bg-[#f1f5f9]">
      <div className="bg-amber-500/15 border-b border-amber-500/30 px-6 py-3 text-center text-sm text-amber-900">
        Your 30-day trial has ended — reactivate your plan below to continue. Your data is safe.
      </div>
      {view === 'billing' ? (
        <Billing onBaaRequired={() => setView('compliance')} />
      ) : (
        <div className="p-6 max-w-4xl mx-auto">
          <button onClick={() => setView('billing')} className="text-sm text-slate-500 hover:text-slate-800 mb-4">
            ← Back to billing
          </button>
          <Compliance />
        </div>
      )}
    </div>
  );
}

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
  const [billing, setBilling] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  // Org-wide MFA enforcement: set when the server blocks a request (or an
  // org-switch) because the workspace requires two-factor the member hasn't
  // completed. { mfaToken?, orgName? }
  const [orgMfa, setOrgMfa] = useState(null);

  useEffect(() => {
    const onOrgMfa = (e) => setOrgMfa(e.detail || {});
    window.addEventListener('claimpaid:org-mfa', onOrgMfa);
    return () => window.removeEventListener('claimpaid:org-mfa', onOrgMfa);
  }, []);
  // Landing pricing CTA (?plan=pro) preselects the plan in the onboarding wizard
  const [planIntent] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('plan');
    return p === 'starter' || p === 'pro' || p === 'ai' ? p : null;
  });

  useEffect(() => {
    if (user) {
      api.billingStatus()
        .then(setBilling)
        .catch(() => setBilling({ products: { rcm: true, ai: true } }));
      api.onboardingStatus()
        .then(setOnboarding)
        .catch(() => setOnboarding({ needed: false }));
    } else {
      setBilling(null);
      setOnboarding(null);
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

  // Workspace requires two-factor the member hasn't completed yet (flag flipped
  // mid-session, or an org-switch that returned an MFA step). This screen
  // guides through the email-code flow — never a dead end.
  if (orgMfa) {
    return <OrgMfaRequiredScreen initialToken={orgMfa.mfaToken} orgName={orgMfa.orgName} />;
  }

  // New owners go through the onboarding funnel before anything else
  if (onboarding?.needed) {
    return (
      <OnboardingWizard
        orgName={onboarding.orgName || ''}
        initialPlan={planIntent || onboarding.plan}
        onComplete={() => {
          window.history.replaceState({}, '', '/app/');
          window.location.reload();
        }}
      />
    );
  }

  // Expired trial: paywall. Billing handles reactivation; Compliance covers the BAA step.
  if (billing?.plan_status === 'expired') {
    return <ExpiredScreen />;
  }

  // AI-only subscribers don't get the RCM dashboard — point them at the AI app
  if (billing && billing.products?.rcm === false) {
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
  const [page, setPage] = useState(() => {
    // After landing-page pricing CTA (?plan=...) for existing users, drop them on Billing
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
  // Plan-limit modal: api.js dispatches 'plan-limit' on 402 quota responses
  const [limitInfo, setLimitInfo] = useState(null);
  useEffect(() => {
    const onLimit = (e) => setLimitInfo(e.detail);
    window.addEventListener('plan-limit', onLimit);
    return () => window.removeEventListener('plan-limit', onLimit);
  }, []);

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
      {page === 'era' && <Era />}
      {page === 'ehr' && <Ehr onViewClaim={(claimId) => go('claims', { claimId })} />}
      {page === 'audit' && <AuditLog />}
      {page === 'billing' && <Billing onBaaRequired={() => go('compliance')} />}
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
    {limitInfo && (
      <LimitModal
        info={limitInfo}
        onClose={() => setLimitInfo(null)}
        onUpgrade={() => { setLimitInfo(null); go('billing'); }}
      />
    )}
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
          <OrgSettingsProvider>
            <Workspace />
          </OrgSettingsProvider>
        </AuthGate>
      </ToastProvider>
    </AuthProvider>
  );
}
