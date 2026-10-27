import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider, ConfirmHost } from './components/ui';
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
import Statements from './pages/Statements';
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
import CreateWorkspaceGate from './components/CreateWorkspaceGate';
import { OrgSettingsProvider } from './orgSettings';

// Plans-only paywall (deploy #61): no active plan and no running trial —
// the ONLY reachable surface is Billing (pick/pay for a plan) and the BAA
// step checkout may demand. The dashboard stays closed until a plan is
// active. `reason`: 'expired' (trial ran out) or 'canceled'.
function ExpiredScreen({ reason }) {
  const [view, setView] = useState('billing');
  return (
    <div className="min-h-screen bg-[#FAF5EB]">
      <div className="bg-amber-500/15 border-b border-amber-500/30 px-6 py-3 text-center text-sm text-amber-900">
        {reason === 'canceled'
          ? 'Your subscription has ended — pick a plan below to continue. Your data is safe.'
          : 'Your 30-day trial has ended — reactivate your plan below to continue. Your data is safe.'}
      </div>
      {view === 'billing' ? (
        <Billing onBaaRequired={() => setView('compliance')} />
      ) : (
        <div className="p-6 max-w-4xl mx-auto">
          <button onClick={() => setView('billing')} className="text-sm text-stone-500 hover:text-stone-800 mb-4">
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
  const [aiLockView, setAiLockView] = useState('lock');

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
      <div className="min-h-screen flex items-center justify-center bg-[#17251F]">
        <div className="flex flex-col items-center gap-4">
          <img src="/app/claimpaid-icon-reverse.webp" alt="ClaimPaid" className="w-12 h-12 rounded-2xl animate-pulse" />
          <div className="text-stone-400 text-sm">Loading ClaimPaid RCM…</div>
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

  // Org-less account (workspace deleted / database reset): create a
  // workspace first — never a dead shell or a login loop.
  if (onboarding?.noOrg) {
    return <CreateWorkspaceGate user={user} />;
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

  // Plans-only paywall: trial over (or canceled past its window) with no
  // paid plan — Billing is the only surface until a plan is active.
  if (billing && billing.access === 'plans_only') {
    return <ExpiredScreen reason={billing.plan_status === 'canceled' ? 'canceled' : 'expired'} />;
  }

  // AI-only subscribers don't get the RCM dashboard — point them at the AI
  // app AND give them the door to add RCM: plan switching lives right here,
  // not behind a new signup (deploy #60).
  if (billing && billing.products?.rcm === false) {
    if (aiLockView === 'billing' || aiLockView === 'compliance') {
      return (
        <div className="min-h-screen bg-[#FAF5EB]">
          <div className="bg-amber-500/15 border-b border-amber-500/30 px-6 py-3 text-center text-sm text-amber-900">
            You're on ClaimPaid AI — switch to a plan with the RCM platform below. No new signup, your data carries over.
          </div>
          {aiLockView === 'billing' ? (
            <Billing onBaaRequired={() => setAiLockView('compliance')} />
          ) : (
            <div className="p-6 max-w-4xl mx-auto">
              <button onClick={() => setAiLockView('billing')} className="text-sm text-stone-500 hover:text-stone-800 mb-4">
                ← Back to billing
              </button>
              <Compliance />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#17251F] px-6">
        <div className="max-w-md w-full text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-2xl mb-5">🤖</div>
          <h1 className="text-2xl font-bold text-white mb-2">You're on ClaimPaid AI</h1>
          <p className="text-stone-400 text-sm mb-6">
            Your subscription covers the AI assistant only. The RCM dashboard (claims, denials, appeals) isn't included in your plan — but you can add it right now.
          </p>
          <div className="space-y-3">
            <a href="/ai/app/" className="btn btn-primary w-full !py-3">Open ClaimPaid AI →</a>
            <button onClick={() => setAiLockView('billing')} className="btn w-full !py-3 !bg-emerald-500 !text-[#17251F] font-bold hover:!bg-emerald-400">
              Add the RCM platform — switch plans
            </button>
          </div>
          <p className="text-stone-500 text-xs mt-4">Workspace owners switch instantly — Stripe prorates the difference.</p>
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
    // Returning from Stripe Connect onboarding (?settings=payments) — land
    // on Organization; the deepLink initializer below opens the Payments
    // tab, which refetches connection status on mount. (No replaceState
    // here: the deepLink initializer still needs to read the param.)
    if (q.get('settings') === 'payments') return 'org';
    return 'work';
  });
  const [dueCount, setDueCount] = useState(0);
  const [authzAlertCount, setAuthzAlertCount] = useState(0);
  // Cross-page deep links: { page, appealId, claimId, startAppealClaimId, settingsTab }
  const [deepLink, setDeepLink] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    return q.get('settings') === 'payments' ? { settingsTab: 'payments' } : null;
  });
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
      {page === 'statements' && <Statements onConnectStripe={() => go('org', { settingsTab: 'payments' })} />}
      {page === 'ehr' && <Ehr onViewClaim={(claimId) => go('claims', { claimId })} />}
      {page === 'audit' && <AuditLog />}
      {page === 'billing' && <Billing onBaaRequired={() => go('compliance')} />}
      {page === 'org' && <Organization initialTab={deepLink?.settingsTab} onTabConsumed={() => setDeepLink(null)} />}
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
    <ConfirmHost />
    </>
  );
}


function SuperAdminGate() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-950">
        <div className="text-stone-500 text-sm">Loading…</div>
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
  return (<><SuperAdmin /><ConfirmHost /></>);
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
