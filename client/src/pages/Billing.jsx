import { useState, useEffect, useRef } from 'react';
import { api, fmtMoney2 } from '../api';
import { PageHeader, Skeleton, Modal } from '../components/ui';
import { useToast } from '../components/ui';

const PLAN_META = {
  trial: { label: 'Trial', desc: 'Exploring ClaimPaid' },
  starter: { label: 'RCM Starter', desc: '$199/month — full RCM platform' },
  pro: { label: 'RCM Pro + AI', desc: '$499/month — everything plus ClaimPaid AI' },
  ai: { label: 'ClaimPaid AI', desc: '$99/month — AI assistant only' },
  enterprise: { label: 'Enterprise', desc: 'Custom annual agreement' },
};

const STATUS_PILL = {
  trialing: 'badge-blue',
  active: 'badge-green',
  past_due: 'badge-amber',
  expired: 'badge-rose',
  canceled: 'badge-slate',
};

// One usage meter: label + "X of Y" + progress bar + Upgrade CTA.
// limit null => unlimited; included false => plan doesn't cover this resource.
function UsageBar({ label, used, limit, unknown, included, onUpgrade }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const hot = limit && used / limit >= 0.8;
  return (
    <div className="py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-sm font-semibold text-stone-800">{label}</div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-stone-500">
            {unknown ? '—' : included === false ? 'Not included' : limit === null || limit === undefined
              ? `${Number(used).toLocaleString('en-US')} used · Unlimited`
              : `${Number(used).toLocaleString('en-US')} of ${Number(limit).toLocaleString('en-US')} used`}
          </div>
          {included !== false && (
            <button onClick={onUpgrade} className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 hover:underline">
              Upgrade
            </button>
          )}
        </div>
      </div>
      {limit !== null && limit !== undefined && included !== false && (
        <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${hot ? 'bg-gradient-to-r from-amber-400 to-rose-500' : 'bg-gradient-to-r from-emerald-400 to-emerald-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {included === false && (
        <div className="text-xs text-stone-500">
          Not included in your plan.{' '}
          <button onClick={onUpgrade} className="font-semibold text-emerald-700 hover:underline">Upgrade to unlock →</button>
        </div>
      )}
      {unknown && (
        <div className="text-xs text-stone-400">Usage unavailable — the AI service isn't reporting yet.</div>
      )}
    </div>
  );
}

function statusLabel(s) {
  if (s.plan_status === 'trialing') {
    return s.trial_days_left > 0 ? `Free trial · ${s.trial_days_left} day${s.trial_days_left === 1 ? '' : 's'} left` : 'Free trial';
  }
  return { active: 'Active', past_due: 'Past due', expired: 'Trial ended', canceled: 'Canceled' }[s.plan_status]
    || (s.plan_status || '').replace(/_/g, ' ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function Billing({ onBaaRequired }) {
  const [status, setStatus] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const plansRef = useRef(null);
  const toast = useToast();

  const load = () => {
    setLoading(true);
    Promise.all([
      api.billingStatus().catch((e) => { toast.error(e.message); return null; }),
      api.billingInvoices().then((r) => r.invoices || []).catch(() => []),
      api.billingUsage().catch(() => null),
    ]).then(([s, inv, u]) => {
      if (s) setStatus(s);
      setInvoices(inv);
      if (u) setUsage(u);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Stripe return banners (?billing=success|cancelled|portal on /app/)
    const q = new URLSearchParams(window.location.search);
    const b = q.get('billing');
    if (b === 'success') {
      window.history.replaceState({}, '', '/app/');
      // Give the webhook a moment to land, then confirm from the real status
      setTimeout(async () => {
        try {
          const s = await api.billingStatus();
          setStatus(s);
          toast.success(
            s?.plan_status === 'trialing'
              ? "You're all set — your card will only be charged when your trial ends."
              : 'Subscription activated — welcome to ClaimPaid!'
          );
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
      const { url } = await api.billingCheckout(plan);
      window.location.href = url;
    } catch (e) {
      if (String(e.message).includes('BAA_REQUIRED')) {
        toast.error('Please sign the BAA first — required before activating a paid subscription.');
        setBusy(null);
        if (onBaaRequired) onBaaRequired();
        return;
      }
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

  // Self-serve cancellation (deploy #54)
  const [showCancel, setShowCancel] = useState(false);
  const [cancelMode, setCancelMode] = useState('period_end');
  const doCancel = async () => {
    setBusy('cancel');
    try {
      const r = await api.billingCancel(cancelMode);
      toast.success(r.message || 'Subscription canceled.');
      setShowCancel(false);
      await load();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(null);
  };
  const doReactivate = async () => {
    setBusy('reactivate');
    try {
      const r = await api.billingReactivate();
      toast.success(r.message || 'Subscription reactivated.');
      await load();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(null);
  };

  // Plan switching (deploy #60): subscribers swap in place via Stripe
  // proration; app-side trials flip instantly. Expired/canceled orgs go
  // through checkout instead (handled by the card buttons).
  const [switchTarget, setSwitchTarget] = useState(null);
  const doChangePlan = async () => {
    const plan = switchTarget;
    if (!plan) return;
    setBusy(plan);
    try {
      const r = await api.billingChangePlan(plan);
      if (r && r.mode === 'checkout') {
        setSwitchTarget(null);
        await checkout(plan);
        return;
      }
      toast.success(r.message || 'Plan switched.');
      setSwitchTarget(null);
      await load();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(null);
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
  const st = status?.plan_status || 'trialing';
  const isTrialing = st === 'trialing';
  const isActive = st === 'active';
  const isPastDue = st === 'past_due';
  const isExpired = st === 'expired';
  const hasCustomer = !!status?.has_customer;
  const plans = status?.plans || {};
  const trialPct = isTrialing && status?.trial_days_left > 0
    ? Math.min(100, Math.max(0, ((30 - status.trial_days_left) / 30) * 100))
    : 0;

  const planCard = (key, name, tagline, price, features) => {
    const isCurrent = planKey === key && (isActive || isTrialing);
    const available = plans[key]?.available;
    return (
      <div key={key} className={`card p-6 flex flex-col ${isCurrent ? 'ring-2 ring-emerald-500' : ''}`}>
        <div className="flex items-center gap-2">
          <div className="font-bold">{name}</div>
          {key === 'pro' && <span className="text-[10px] font-bold bg-emerald-500 text-[#17251F] px-2 py-0.5 rounded-full">MOST POPULAR</span>}
        </div>
        <div className="text-xs text-stone-500 mt-0.5">{tagline}</div>
        <div className="text-3xl font-extrabold mt-3 tracking-tight">{price}</div>
        <ul className="text-[13px] text-stone-600 mt-4 space-y-1.5 flex-1">
          {features.map((f) => <li key={f}>✓ {f}</li>)}
        </ul>
        <div className="mt-5">
          {isCurrent ? (
            <span className="badge badge-green">Current plan</span>
          ) : isExpired || st === 'canceled' ? (
            <button
              className={`btn w-full ${key === 'ai' ? 'btn-outline' : 'btn-primary'}`}
              disabled={busy === key || !available}
              onClick={() => checkout(key)}
              title={!available ? 'Not priced yet' : undefined}
            >
              {busy === key ? 'Redirecting…' : isExpired ? `Reactivate ${name}` : `Choose ${name}`}
            </button>
          ) : (
            <button
              className={`btn w-full ${key === 'ai' ? 'btn-outline' : 'btn-primary'}`}
              disabled={busy === key || !available}
              onClick={() => setSwitchTarget(key)}
              title={!available ? 'Not priced yet' : undefined}
            >
              {busy === key ? 'Switching…' : `Switch to ${name}`}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <PageHeader title="Billing & Plan" subtitle="Manage your ClaimPaid subscription. Cancel anytime." />

      {/* ── Expired paywall hero ── */}
      {isExpired && (
        <div className="rounded-3xl bg-[#17251F] text-white p-8 text-center">
          <div className="text-4xl mb-3">⏳</div>
          <h2 className="text-2xl font-extrabold tracking-tight mb-2">Your trial has ended</h2>
          <p className="text-stone-400 max-w-md mx-auto mb-6">
            You were trying <span className="text-white font-semibold">{meta.label}</span> ({meta.desc}).
            Reactivate to pick up right where you left off — your data is safe.
          </p>
          <button
            className="btn btn-primary !px-8 !py-3 !text-base !rounded-2xl"
            disabled={busy === planKey || !plans[planKey]?.available}
            onClick={() => checkout(planKey)}
          >
            {busy === planKey ? 'Redirecting…' : `Reactivate ${meta.label} →`}
          </button>
          <p className="text-stone-500 text-sm mt-4">
            Want a different plan? Pick one below — same 30-day terms apply from today.
          </p>
        </div>
      )}

      {/* ── Status card ── */}
      <div className="card p-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-1">Current plan</div>
            <div className="text-xl font-bold tracking-tight">{meta.label}</div>
            <div className="text-sm text-stone-500 mt-0.5">{meta.desc}</div>
            {isTrialing && status?.trial_ends_at && (
              <div className="text-xs text-stone-500 mt-2">
                Trial ends {fmtDate(status.trial_ends_at)} — add a payment method to keep {meta.label}.
              </div>
            )}
            {(isActive || isPastDue) && status?.current_period_end && (
              <div className="text-xs text-stone-500 mt-2">
                Next invoice {fmtDate(status.current_period_end)}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className={`badge ${STATUS_PILL[st] || STATUS_PILL.trialing}`}>{statusLabel(status)}</span>
            {isTrialing && (
              <button className="btn btn-primary" disabled={busy === planKey} onClick={() => checkout(planKey)}>
                {busy === planKey ? 'Redirecting…' : 'Add payment method'}
              </button>
            )}
            {(isActive || isPastDue) && hasCustomer && (
              <button className="btn btn-ghost" disabled={busy === 'portal'} onClick={openPortal}>
                {busy === 'portal' ? 'Opening…' : isPastDue ? 'Update payment method' : 'Manage billing'}
              </button>
            )}
            {((isActive || isPastDue) || (isTrialing && hasCustomer)) && !status?.cancel_at_period_end && planKey !== 'enterprise' && (
              <button className="btn btn-ghost !text-red-600" onClick={() => { setCancelMode('period_end'); setShowCancel(true); }}>
                Cancel subscription
              </button>
            )}
          </div>
        </div>
        {isTrialing && status?.trial_days_left > 0 && (
          <div className="mt-5">
            <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500"
                style={{ width: `${trialPct}%` }}
              />
            </div>
            <div className="text-xs text-stone-500 mt-1.5">
              Day {30 - status.trial_days_left + 1} of your 30-day free trial · No card on file · Cancel anytime by simply not adding one
            </div>
          </div>
        )}
        {status?.cancel_at_period_end && (
          <div className="mt-4 flex items-center justify-between flex-wrap gap-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <span>
              {isTrialing
                ? <>Your trial ends on <strong>{fmtDate(status.trial_ends_at)}</strong> and won't convert to a paid plan — you keep full access until then.</>
                : <>Your plan cancels on <strong>{fmtDate(status.current_period_end)}</strong> — you keep full access until then, and you won't be charged again.</>}
            </span>
            <button className="btn btn-primary !py-1.5" disabled={busy === 'reactivate'} onClick={doReactivate}>
              {busy === 'reactivate' ? 'Working…' : 'Keep my plan'}
            </button>
          </div>
        )}
        {isTrialing && !hasCustomer && st !== 'canceled' && (
          <div className="mt-4 text-xs text-stone-400">
            Prefer to stop now? <button className="underline hover:text-stone-600" onClick={() => { setCancelMode('immediate'); setShowCancel(true); }}>End your trial</button> — it won't convert, and you keep access until the trial end date.
          </div>
        )}
        {!status?.stripe_configured && (
          <div className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            Online checkout isn't enabled on this server yet — contact us to activate your plan.
          </div>
        )}
      </div>

      {/* ── Cancel confirm modal ── */}
      {showCancel && (
        <Modal onClose={() => busy !== 'cancel' && setShowCancel(false)}>
          <div className="p-7">
            <h3 className="text-xl font-bold tracking-tight mb-2">Cancel {meta.label}?</h3>
            {isTrialing ? (
              <p className="text-sm text-stone-600 mb-5">
                Your trial will end on <strong>{fmtDate(status.trial_ends_at)}</strong> and won't convert to a paid plan.
                You keep <strong>full access until that date</strong> — canceling never shortens a trial — and you can undo
                this anytime before then with “Keep my plan”.
              </p>
            ) : hasCustomer ? (
              <>
                <p className="text-sm text-stone-600 mb-4">
                  No hard feelings — and no cancellation fees, ever. Your data stays available in read-only export for 30 days after access ends.
                </p>
                <label className="flex items-start gap-2.5 text-sm mb-2 cursor-pointer">
                  <input type="radio" className="mt-0.5" checked={cancelMode === 'period_end'} onChange={() => setCancelMode('period_end')} />
                  <span><strong>Cancel at period end</strong> — keep full access until {status?.current_period_end ? fmtDate(status.current_period_end) : 'the period ends'}, no further charges.</span>
                </label>
                <label className="flex items-start gap-2.5 text-sm mb-5 cursor-pointer">
                  <input type="radio" className="mt-0.5" checked={cancelMode === 'immediate'} onChange={() => setCancelMode('immediate')} />
                  <span><strong>Cancel immediately</strong> — access ends right now.</span>
                </label>
              </>
            ) : (
              <p className="text-sm text-stone-600 mb-5">
                This ends your subscription today. You can sign up again anytime.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" disabled={busy === 'cancel'} onClick={() => setShowCancel(false)}>Keep my plan</button>
              <button className="btn !bg-rose-600 !text-white hover:!bg-rose-700" disabled={busy === 'cancel'} onClick={doCancel}>
                {busy === 'cancel' ? 'Canceling…' : isTrialing ? 'Yes, end at trial end' : 'Yes, cancel'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Switch-plan confirm modal ── */}
      {switchTarget && (
        <Modal onClose={() => busy !== switchTarget && setSwitchTarget(null)}>
          <div className="p-7">
            <h3 className="text-xl font-bold tracking-tight mb-2">Switch to {PLAN_META[switchTarget]?.label}?</h3>
            <p className="text-sm text-stone-600 mb-2">
              {PLAN_META[switchTarget]?.desc}. The switch takes effect immediately — your team, claims and data don't change.
            </p>
            {isTrialing && !status?.has_subscription ? (
              <p className="text-sm text-stone-600 mb-5">
                You're still in your free trial with no card on file, so there's no charge — your trial end date
                {status?.trial_ends_at ? <> (<strong>{fmtDate(status.trial_ends_at)}</strong>)</> : ''} stays the same.
              </p>
            ) : (
              <p className="text-sm text-stone-600 mb-5">
                Stripe prorates the change: upgrading charges the difference pro-rata on your next invoice;
                downgrading credits it.
                {status?.cancel_at_period_end && <> Switching also cancels your scheduled cancellation — your subscription continues on the new plan.</>}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" disabled={busy === switchTarget} onClick={() => setSwitchTarget(null)}>Keep current plan</button>
              <button className="btn btn-primary" disabled={busy === switchTarget} onClick={doChangePlan}>
                {busy === switchTarget ? 'Switching…' : `Switch to ${PLAN_META[switchTarget]?.label}`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Usage this month ── */}
      {usage && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-1">Usage this month</div>
              <div className="text-sm text-stone-500">Quotas reset on the 1st (UTC). Upgrade anytime to raise your limits.</div>
            </div>
          </div>
          <div className="divide-y divide-stone-100">
            <UsageBar
              label="Claims created"
              used={usage.claims.used}
              limit={usage.claims.limit}
              included={usage.claims.limit !== 0}
              onUpgrade={() => plansRef.current?.scrollIntoView({ behavior: 'smooth' })}
            />
            <UsageBar
              label="Team seats"
              used={usage.seats.used}
              limit={usage.seats.limit}
              onUpgrade={() => plansRef.current?.scrollIntoView({ behavior: 'smooth' })}
            />
            <UsageBar
              label="AI queries"
              used={usage.aiQueries.used}
              limit={usage.aiQueries.limit}
              unknown={usage.aiQueries.unknown}
              included={usage.aiQueries.limit !== 0}
              onUpgrade={() => plansRef.current?.scrollIntoView({ behavior: 'smooth' })}
            />
          </div>
        </div>
      )}

      {/* ── Plan picker ── */}
      {(
        <>
          <div ref={plansRef} className="flex items-center justify-between">
            <h3 className="font-bold text-stone-900">
              {isExpired ? 'Or switch plans' : isActive || isPastDue ? 'Switch plans' : isTrialing ? 'Compare plans' : 'Plans'}
            </h3>
            {isTrialing && (
              <span className="text-xs text-stone-500">Switching keeps your remaining trial days</span>
            )}
            {(isActive || isPastDue) && (
              <span className="text-xs text-stone-500">Switching is instant — Stripe prorates the difference</span>
            )}
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
            {planCard('starter', 'RCM Starter', 'For small billing teams', <><>$199</><span className="text-sm font-normal text-stone-500">/mo</span></>,
              ['Full RCM platform', '1,000 claims/month', 'Timely filing radar + 13-rule scrubber', 'Auto appeal letters (8 categories)', '835 import / 837P export', 'Up to 3 team seats'])}
            {planCard('pro', 'RCM Pro + AI', 'For teams serious about denial recovery', <><>$499</><span className="text-sm font-normal text-stone-500">/mo</span></>,
              ['Everything in Starter', '10,000 claims/month', 'ClaimPaid AI — embedded tab + quick-chat', '2,000 AI queries/month', 'Payer Policy Handbook, pre-loaded', 'Autopilot crawling + Teach-it loop', 'Denial pattern analytics', 'Up to 15 team seats'])}
            {planCard('ai', 'ClaimPaid AI', 'Just the AI assistant', <><>$99</><span className="text-sm font-normal text-stone-500">/mo</span></>,
              ['Private AI chat over your documents', '1,000 AI queries/month', 'Cited answers, grounded in your KB', 'Unlimited knowledge bases', 'Public share links + embed widget', 'Up to 5 team seats', 'Your data never leaves our servers'])}
            <div className="card p-6 flex flex-col">
              <div className="font-bold">Enterprise</div>
              <div className="text-xs text-stone-500 mt-0.5">For large billing companies & MSOs</div>
              <div className="text-3xl font-extrabold mt-3 tracking-tight">Custom</div>
              <ul className="text-[13px] text-stone-600 mt-4 space-y-1.5 flex-1">
                {['Everything in Pro + AI', 'Multi-org management + SSO', 'Custom KB training on your contracts', 'Dedicated success manager', 'SLA + priority support'].map((f) => <li key={f}>✓ {f}</li>)}
              </ul>
              <div className="mt-5">
                <button className="btn btn-ghost w-full"
                  onClick={() => { window.location.href = 'mailto:support@claimpaid.io?subject=ClaimPaid Enterprise'; }}>
                  Talk to us
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Invoices ── */}
      {invoices.length > 0 && (
        <div className="card p-6">
          <h3 className="font-bold text-stone-900 mb-4">Invoices</h3>
          <div className="divide-y divide-stone-100">
            {invoices.map((inv) => (
              <div key={inv.number} className="flex items-center justify-between py-3 gap-4">
                <div>
                  <div className="text-sm font-semibold text-stone-900">{inv.number}</div>
                  <div className="text-xs text-stone-500">{fmtDate(inv.date)} · {inv.currency}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`badge ${inv.status === 'paid' ? 'badge-green' : inv.status === 'open' ? 'badge-amber' : 'badge-slate'}`}>
                    {(inv.status || '').toUpperCase()}
                  </span>
                  <span className="text-sm font-bold text-stone-900 w-20 text-right">{fmtMoney2(inv.amount / 100)}</span>
                  {inv.pdf && (
                    <a href={inv.pdf} target="_blank" rel="noreferrer" className="btn btn-ghost !px-3 !py-1.5 !text-xs">
                      PDF
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-stone-500">
        Payments are processed securely by Stripe. We never see or store your card details.
      </p>
    </div>
  );
}
