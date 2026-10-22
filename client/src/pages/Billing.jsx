import { useState, useEffect } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

const PLAN_META = {
  trial: { label: 'Trial', desc: 'Exploring ClaimPaid' },
  starter: { label: 'RCM Starter', desc: '$199/month — full RCM platform' },
  pro: { label: 'RCM Pro + AI', desc: '$499/month — everything plus ClaimPaid AI' },
  enterprise: { label: 'Enterprise', desc: 'Custom annual agreement' },
};

const STATUS_BADGE = {
  trialing: 'badge-blue',
  active: 'badge-green',
  past_due: 'badge-amber',
  canceled: 'badge-slate',
};

export default function Billing({ defaultTrial = false }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [trial, setTrial] = useState(defaultTrial);
  const toast = useToast();

  const load = () => {
    setLoading(true);
    api.billingStatus()
      .then(setStatus)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Stripe return banners (?billing=success|cancelled|portal on /app/)
    const q = new URLSearchParams(window.location.search);
    const b = q.get('billing');
    if (b === 'success') {
      window.history.replaceState({}, '', '/app/');
      // Give the webhook a moment to land, then toast based on the real status
      setTimeout(async () => {
        try {
          const s = await api.billingStatus();
          setStatus(s);
          toast.success(s?.plan_status === 'trialing'
            ? 'Free trial started — no charge for 30 days. Welcome to ClaimPaid!'
            : 'Subscription activated — welcome to ClaimPaid!');
        } catch { /* load() below covers errors */ }
        setLoading(false);
      }, 2500);
    } else if (b === 'cancelled') {
      toast.info('Checkout cancelled — no charge was made.');
      window.history.replaceState({}, '', '/app/');
    } else if (b === 'portal') {
      window.history.replaceState({}, '', '/app/');
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkout = async (plan) => {
    setBusy(plan);
    try {
      const { url } = await api.billingCheckout(plan, trial);
      window.location.href = url;
    } catch (e) {
      toast.error(e.message);
      setBusy(null);
    }
  };

  const openPortal = async () => {
    setBusy('portal');
    try {
      const { url } = await api.billingPortal();
      window.location.href = url;
    } catch (e) {
      toast.error(e.message);
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <PageHeader title="Billing & Plan" subtitle="Manage your ClaimPaid subscription." />
        <Skeleton className="h-40 mt-6" />
      </div>
    );
  }

  const planKey = status?.plan || 'trial';
  const meta = PLAN_META[planKey] || PLAN_META.trial;
  const isActive = status?.plan_status === 'active';
  const hasCustomer = !!status?.has_customer;
  const plans = status?.plans || {};

  const planCard = (key, name, tagline, price, features, cta) => (
    <div key={key} className={`card p-6 flex flex-col ${planKey === key && isActive ? 'ring-2 ring-emerald-500' : ''}`}>
      <div className="flex items-center gap-2">
        <div className="font-bold">{name}</div>
        {key === 'pro' && <span className="text-[10px] font-bold bg-emerald-500 text-[#0b1220] px-2 py-0.5 rounded-full">MOST POPULAR</span>}
      </div>
      <div className="text-xs text-slate-500 mt-0.5">{tagline}</div>
      <div className="text-3xl font-extrabold mt-3 tracking-tight">{price}</div>
      <ul className="text-[13px] text-slate-600 mt-4 space-y-1.5 flex-1">
        {features.map((f) => <li key={f}>✓ {f}</li>)}
      </ul>
      <div className="mt-5">{cta}</div>
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader title="Billing & Plan" subtitle="Manage your ClaimPaid subscription. Cancel anytime." />

      {/* Current plan */}
      <div className="card p-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1">Current plan</div>
            <div className="text-xl font-bold tracking-tight">{meta.label}</div>
            <div className="text-sm text-slate-500 mt-0.5">{meta.desc}</div>
            {status?.current_period_end && (
              <div className="text-xs text-slate-500 mt-2">
                Renews {new Date(status.current_period_end).toLocaleDateString()}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className={`badge ${STATUS_BADGE[status?.plan_status] || STATUS_BADGE.trialing}`}>
              {(status?.plan_status || 'trialing').replace('_', ' ').toUpperCase()}
            </span>
            {hasCustomer && (
              <button className="btn btn-ghost" disabled={busy === 'portal'} onClick={openPortal}>
                {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
              </button>
            )}
          </div>
        </div>
        {!status?.stripe_configured && (
          <div className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            Online checkout isn't enabled on this server yet — contact us to activate your plan.
          </div>
        )}
      </div>

      {/* Plan picker */}
      {!isActive && (
        <button
          onClick={() => setTrial((t) => !t)}
          className={`w-full flex items-center gap-4 rounded-2xl border-2 px-5 py-4 text-left transition ${
            trial ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition ${
            trial ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 text-transparent'
          }`}>✓</span>
          <span>
            <span className="block font-semibold text-slate-900">Start with 1 month free</span>
            <span className="block text-sm text-slate-500">No charge today — your selected plan begins automatically after 30 days. Cancel anytime during the trial.</span>
          </span>
        </button>
      )}
      <div className="grid md:grid-cols-3 gap-4">
        {planCard('starter', 'RCM Starter', 'For small billing teams', <><>$199</><span className="text-sm font-normal text-slate-500">/mo</span></>,
          ['Full RCM platform', 'Timely filing radar + 13-rule scrubber', 'Auto appeal letters (8 categories)', '835 import / 837P export', 'Up to 3 team seats'],
          planKey === 'starter' && isActive
            ? <span className="badge badge-green">Current plan</span>
            : <button className="btn btn-primary w-full" disabled={busy === 'starter' || !plans.starter?.available}
                onClick={() => checkout('starter')}>{busy === 'starter' ? 'Redirecting…' : trial ? 'Start free trial' : 'Choose Starter'}</button>)}
        {planCard('pro', 'RCM Pro + AI', 'For teams serious about denial recovery', <><>$499</><span className="text-sm font-normal text-slate-500">/mo</span></>,
          ['Everything in Starter', 'ClaimPaid AI — embedded tab + quick-chat', 'Payer Policy Handbook, pre-loaded', 'Autopilot crawling + Teach-it loop', 'Denial pattern analytics', 'Unlimited team seats'],
          planKey === 'pro' && isActive
            ? <span className="badge badge-green">Current plan</span>
            : <button className="btn btn-primary w-full" disabled={busy === 'pro' || !plans.pro?.available}
                onClick={() => checkout('pro')}>{busy === 'pro' ? 'Redirecting…' : trial ? 'Start free trial' : 'Choose Pro + AI'}</button>)}
        {planCard('enterprise', 'Enterprise', 'For large billing companies & MSOs', 'Custom',
          ['Everything in Pro + AI', 'Multi-org management + SSO', 'Custom KB training on your contracts', 'Dedicated success manager', 'SLA + priority support'],
          <button className="btn btn-ghost w-full"
            onClick={() => { window.location.href = 'mailto:hello@claimpaid.io?subject=ClaimPaid Enterprise'; }}>
            Talk to us
          </button>)}
      </div>

      <p className="text-xs text-slate-500">
        Payments are processed securely by Stripe. We never see or store your card details.
      </p>
    </div>
  );
}
