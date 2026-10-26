import { useState } from 'react';
import { api } from '../api';

const TEAM_SIZES = ['Just me', '2–10', '11–50', '51+'];
const ROLES = ['Owner', 'Billing manager', 'Biller', 'Practice admin', 'Other'];
const GOALS = [
  { id: 'denials', label: 'Reduce denials', desc: 'Catch and fix issues before they cost you' },
  { id: 'faster', label: 'Get paid faster', desc: 'Shorten the road from claim to cash' },
  { id: 'cleaner', label: 'Cleaner claims', desc: 'Scrub every claim before it goes out' },
  { id: 'auth', label: 'Fewer prior-auth headaches', desc: 'Track auths so nothing slips' },
  { id: 'analytics', label: 'See the full picture', desc: 'Denial patterns, payer stats, trends' },
  { id: 'ai', label: 'AI assistance', desc: 'Answers grounded in your payer policies' },
];
const PLANS = [
  {
    key: 'starter', name: 'RCM Starter', price: 199,
    tagline: 'For small billing teams',
    features: ['Full RCM platform', 'Timely filing radar + claim scrubber', 'Auto appeal letters', '835 import / 837P export'],
  },
  {
    key: 'pro', name: 'RCM Pro + AI', price: 499, popular: true,
    tagline: 'For teams serious about denial recovery',
    features: ['Everything in Starter', 'ClaimPaid AI, embedded', 'Payer Policy Handbook pre-loaded', 'Denial pattern analytics'],
  },
  {
    key: 'ai', name: 'ClaimPaid AI', price: 99,
    tagline: 'Just the AI assistant',
    features: ['Private AI chat over your documents', 'Cited answers from your knowledge base', 'Unlimited knowledge bases', 'Share links + embed widget'],
  },
];
const PLAN_NAMES = { starter: 'RCM Starter', pro: 'RCM Pro + AI', ai: 'ClaimPaid AI' };

const STEPS = ['Welcome', 'Workspace', 'Goals', 'Plan', 'Done'];

function Shell({ step, children, wide }) {
  return (
    <div className="fixed inset-0 z-[100] bg-[#17251F] overflow-y-auto">
      <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
        <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
          {/* Brand */}
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <img src="/app/claimpaid-icon.webp" alt="ClaimPaid" className="w-9 h-9 rounded-xl" />
            <span className="text-white font-extrabold text-lg tracking-tight">ClaimPaid</span>
          </div>
          {/* Progress */}
          <div className="mb-8">
            <div className="flex justify-between text-[11px] font-semibold uppercase tracking-widest text-stone-500 mb-2">
              <span>Step {step + 1} of {STEPS.length}</span>
              <span>{STEPS[step]}</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="wiz-progress-fill h-full rounded-full bg-emerald-400"
                style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
              />
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function BackLink({ onClick, label = '← Back' }) {
  return (
    <button onClick={onClick} className="text-sm text-stone-400 hover:text-white transition mt-6">
      {label}
    </button>
  );
}

function SkipLink({ onClick }) {
  return (
    <button onClick={onClick} className="text-sm text-stone-500 hover:text-stone-300 transition mt-6 underline underline-offset-4">
      Skip for now →
    </button>
  );
}

const inputCls =
  'w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-stone-500 ' +
  'focus:outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/20 transition text-[15px]';
const selectCls = inputCls + ' appearance-none [&>option]:text-stone-900';

export default function OnboardingWizard({ orgName = '', initialPlan = null, onComplete }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [companyName, setCompanyName] = useState(orgName || '');
  const [teamSize, setTeamSize] = useState(TEAM_SIZES[0]);
  const [role, setRole] = useState(ROLES[0]);
  const [goals, setGoals] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [fieldError, setFieldError] = useState(null);

  const go = (next) => {
    setDir(next > step ? 1 : -1);
    setFieldError(null);
    setError(null);
    setStep(next);
  };

  const toggleGoal = (id) =>
    setGoals((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  const choosePlan = async (planKey) => {
    setBusy(planKey);
    setError(null);
    try {
      const r = await api.onboardingComplete({
        companyName: companyName.trim(),
        teamSize,
        role,
        goals,
        plan: planKey,
      });
      setResult(r);
      go(4);
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const trialEndDate = result?.trial_ends_at
    ? new Date(result.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <Shell step={step} wide={step === 3}>
      <div key={step} className={dir > 0 ? 'wiz-step-fwd' : 'wiz-step-back'}>
        {/* ── Step 0: Welcome ─────────────────────────────── */}
        {step === 0 && (
          <div className="text-center">
            <div className="text-5xl mb-5">👋</div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-3">
              Welcome to ClaimPaid
            </h1>
            <p className="text-stone-400 mb-8 max-w-md mx-auto">
              Let's get your workspace set up. It takes about a minute:
            </p>
            <div className="text-left max-w-md mx-auto space-y-3.5 mb-10">
              {[
                ['🎯', 'Pick your plan', 'Start with a 30-day free trial — no credit card required.'],
                ['🏢', 'Tell us about your team', 'So we can tailor the workspace to how you bill.'],
                ['💰', 'Start recovering revenue', 'Scrub claims, fight denials, and get paid faster.'],
              ].map(([emoji, title, desc]) => (
                <div key={title} className="flex gap-4 items-start bg-white/5 border border-white/10 rounded-2xl p-4">
                  <div className="text-2xl shrink-0">{emoji}</div>
                  <div>
                    <div className="text-white font-semibold text-[15px]">{title}</div>
                    <div className="text-stone-400 text-sm">{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => go(1)} className="btn btn-primary !px-8 !py-3.5 !text-base !rounded-2xl">
              Get started →
            </button>
          </div>
        )}

        {/* ── Step 1: Workspace ───────────────────────────── */}
        {step === 1 && (
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2 text-center">
              Tell us about your workspace
            </h1>
            <p className="text-stone-400 text-center mb-8">This helps us set things up the right way.</p>
            <div className="space-y-5 max-w-md mx-auto">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-stone-500 mb-2">
                  Company name
                </label>
                <input
                  className={inputCls}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Billing Services"
                  maxLength={120}
                />
                {fieldError && <div className="text-rose-400 text-sm mt-2">{fieldError}</div>}
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-stone-500 mb-2">
                  Team size
                </label>
                <select className={selectCls} value={teamSize} onChange={(e) => setTeamSize(e.target.value)}>
                  {TEAM_SIZES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest text-stone-500 mb-2">
                  Your role
                </label>
                <select className={selectCls} value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="text-center">
              <button
                onClick={() => {
                  if (!companyName.trim()) { setFieldError('Please enter your company name.'); return; }
                  go(2);
                }}
                className="btn btn-primary !px-8 !py-3 !rounded-2xl mt-8"
              >
                Continue →
              </button>
              <div className="flex items-center justify-center gap-6">
                <BackLink onClick={() => go(0)} />
                <SkipLink onClick={() => go(2)} />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Goals ───────────────────────────────── */}
        {step === 2 && (
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2 text-center">
              What should ClaimPaid do for you?
            </h1>
            <p className="text-stone-400 text-center mb-8">Pick everything that matters — at least one.</p>
            <div className="grid sm:grid-cols-2 gap-3 max-w-xl mx-auto">
              {GOALS.map((g) => {
                const on = goals.includes(g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => { toggleGoal(g.id); setFieldError(null); }}
                    className={`text-left rounded-2xl border-2 p-4 transition ${
                      on
                        ? 'border-emerald-400 bg-emerald-400/10'
                        : 'border-white/10 bg-white/5 hover:border-white/25'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-white font-semibold text-[15px]">{g.label}</div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[11px] transition ${
                        on ? 'border-emerald-400 bg-emerald-400 text-[#17251F]' : 'border-stone-600 text-transparent'
                      }`}>✓</div>
                    </div>
                    <div className="text-stone-400 text-sm mt-1">{g.desc}</div>
                  </button>
                );
              })}
            </div>
            {fieldError && <div className="text-rose-400 text-sm mt-4 text-center">{fieldError}</div>}
            <div className="text-center">
              <button
                onClick={() => {
                  if (!goals.length) { setFieldError('Pick at least one goal — or skip for now.'); return; }
                  go(3);
                }}
                className="btn btn-primary !px-8 !py-3 !rounded-2xl mt-8"
              >
                Continue →
              </button>
              <div className="flex items-center justify-center gap-6">
                <BackLink onClick={() => go(1)} />
                <SkipLink onClick={() => go(3)} />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Plan ────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2 text-center">
              Choose your plan
            </h1>
            <p className="text-stone-400 text-center mb-8">Every plan starts with a 30-day free trial.</p>
            {error && (
              <div className="max-w-2xl mx-auto mb-6 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-4 py-3">
                {error}
              </div>
            )}
            <div className="grid md:grid-cols-3 gap-4">
              {PLANS.map((p) => (
                <div
                  key={p.key}
                  className={`relative rounded-3xl border-2 p-6 flex flex-col transition bg-white/5 ${
                    initialPlan === p.key ? 'border-emerald-400' : 'border-white/10'
                  } ${p.popular ? 'md:-my-2 md:py-8' : ''}`}
                >
                  {p.popular && (
                    <div className="absolute -top-3 left-1/2 -transtone-x-1/2 text-[10px] font-extrabold tracking-widest bg-emerald-400 text-[#17251F] px-3 py-1 rounded-full">
                      MOST POPULAR
                    </div>
                  )}
                  <div className="text-white font-bold text-lg">{p.name}</div>
                  <div className="text-stone-400 text-xs mt-0.5 mb-4">{p.tagline}</div>
                  <div className="text-white mb-5">
                    <span className="text-4xl font-extrabold tracking-tight">${p.price}</span>
                    <span className="text-stone-400 text-sm">/mo</span>
                  </div>
                  <ul className="text-[13px] text-stone-300 space-y-2 flex-1 mb-6">
                    {p.features.map((f) => <li key={f}>✓ {f}</li>)}
                  </ul>
                  <button
                    onClick={() => choosePlan(p.key)}
                    disabled={busy !== null}
                    className={`btn w-full !py-3 !rounded-2xl ${p.popular ? 'btn-primary' : 'bg-white/10 hover:bg-white/15 text-white'}`}
                  >
                    {busy === p.key ? 'Starting…' : 'Start 30-day free trial'}
                  </button>
                </div>
              ))}
            </div>
            <p className="text-center text-stone-500 text-sm mt-6">
              Free for 30 days · No credit card required · Cancel anytime
            </p>
            <div className="text-center">
              <BackLink onClick={() => go(2)} />
            </div>
          </div>
        )}

        {/* ── Step 4: Success ─────────────────────────────── */}
        {step === 4 && (
          <div className="text-center">
            <div className="wiz-check w-20 h-20 mx-auto mb-6 rounded-full bg-emerald-400/15 border border-emerald-400/40 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-10 h-10" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path className="wiz-check-path" d="M4 12.5l5 5L20 6.5" />
              </svg>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-3">
              You're all set! 🎉
            </h1>
            <p className="text-stone-300 text-lg mb-2">
              You're on <span className="font-bold text-white">{PLAN_NAMES[result?.plan] || 'your plan'}</span> — free for 30 days.
            </p>
            {trialEndDate && (
              <p className="text-stone-400 mb-10">
                Your trial ends <span className="text-emerald-300 font-semibold">{trialEndDate}</span>.
                Add a payment method anytime before then to keep going.
              </p>
            )}
            <button onClick={onComplete} className="btn btn-primary !px-8 !py-3.5 !text-base !rounded-2xl">
              Enter your workspace →
            </button>
          </div>
        )}
      </div>
    </Shell>
  );
}
