const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');
const { baaSignedForOrg } = require('./legal');

const router = express.Router();

// ---- Stripe client (lazy; null when not configured) ----
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // STRIPE_API_BASE exists so tests can point the SDK at a fake Stripe
  // (this SDK version takes host/port/protocol, not an apiBase string).
  let cfg;
  if (process.env.STRIPE_API_BASE) {
    try {
      const u = new URL(process.env.STRIPE_API_BASE);
      cfg = { protocol: u.protocol.replace(':', ''), host: u.hostname, port: u.port || undefined };
    } catch {}
  }
  _stripe = require('stripe')(key, cfg);
  return _stripe;
}

// ---- Plans ----
const PLANS = {
  starter: {
    name: 'RCM Starter',
    amount: 19900,
    priceEnv: 'STRIPE_PRICE_STARTER',
    get priceId() { return process.env[this.priceEnv]; },
  },
  pro: {
    name: 'RCM Pro + AI',
    amount: 49900,
    priceEnv: 'STRIPE_PRICE_PRO',
    get priceId() { return process.env[this.priceEnv]; },
  },
  ai: {
    name: 'ClaimPaid AI',
    amount: 9900,
    priceEnv: 'STRIPE_PRICE_AI',
    get priceId() { return process.env[this.priceEnv]; },
  },
};

// Which products a plan unlocks. trial / null / unknown => full access (trial evaluates everything,
// legacy orgs without billing are grandfathered).
function productsForPlan(plan) {
  switch (plan) {
    case 'starter': return { rcm: true, ai: false };
    case 'pro': return { rcm: true, ai: true };
    case 'ai': return { rcm: false, ai: true };
    case 'enterprise': return { rcm: true, ai: true };
    default: return { rcm: true, ai: true };
  }
}

// Effective plan status: an app-side trial whose end date has passed is 'expired'.
// Legacy trialing orgs with no trial_ends_at (pre-onboarding) keep 'trialing' —
// the migration never strands an existing org behind a paywall.
function getEffectivePlanStatus(org) {
  if (!org) return 'trialing';
  const raw = org.plan_status || 'trialing';
  if (raw === 'trialing' && org.trial_ends_at) {
    if (new Date(org.trial_ends_at).getTime() <= Date.now()) return 'expired';
  }
  return raw;
}

// Products for an org, honoring trial expiry: an expired trial unlocks
// nothing — and neither does a canceled subscription past its access
// window (deploy #54: before this, a canceled org kept its paid plan's
// products forever). Deploy #61: a subscription canceled DURING the trial
// keeps its products until the trial end date — canceling stops the
// conversion, never the trial itself (the Stripe/SaaS norm).
function productsForOrg(org) {
  const eff = getEffectivePlanStatus(org);
  if (eff === 'expired') return { rcm: false, ai: false };
  if (eff === 'canceled') {
    if (org?.trial_ends_at && new Date(org.trial_ends_at).getTime() > Date.now()) {
      return productsForPlan(org?.plan);
    }
    return { rcm: false, ai: false };
  }
  return productsForPlan(org?.plan);
}

// Whole days of app trial remaining, for Stripe's trial_period_days so billing
// starts exactly when the app trial ends. 0 = no trial time left.
function getTrialPeriodDays(org) {
  if (getEffectivePlanStatus(org) !== 'trialing' || !org?.trial_ends_at) return 0;
  const msLeft = new Date(org.trial_ends_at).getTime() - Date.now();
  if (msLeft <= 0) return 0;
  return Math.max(1, Math.ceil(msLeft / 86400000));
}

function planFromPriceId(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId && priceId === process.env.STRIPE_PRICE_AI) return 'ai';
  return null;
}

function billingConfigured(res) {
  if (!getStripe()) {
    res.status(503).json({ error: 'Billing is not configured yet. Add STRIPE_SECRET_KEY to enable checkout.' });
    return false;
  }
  return true;
}

function getOrg(orgId) {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
}

async function getOrCreateCustomer(stripe, org, ownerEmail) {
  if (org.stripe_customer_id) {
    try {
      return await stripe.customers.retrieve(org.stripe_customer_id);
    } catch (e) { /* fall through and recreate */ }
  }
  const customer = await stripe.customers.create({
    name: org.name,
    email: ownerEmail || undefined,
    metadata: { org_id: String(org.id) },
  });
  db.prepare('UPDATE orgs SET stripe_customer_id = ? WHERE id = ?').run(customer.id, org.id);
  return customer;
}

// Full billing status payload for an org (shared by /status and onboarding).
function billingStatusFor(org) {
  const effStatus = getEffectivePlanStatus(org);
  const trialEndsAt = org.trial_ends_at || null;
  const msLeft = trialEndsAt ? new Date(trialEndsAt).getTime() - Date.now() : 0;
  const products = productsForOrg(org);
  return {
    plan: org.plan || 'trial',
    plan_status: effStatus,
    trial_ends_at: trialEndsAt,
    trial_days_left: msLeft > 0 ? Math.ceil(msLeft / 86400000) : 0,
    is_trialing: effStatus === 'trialing',
    current_period_end: org.current_period_end || null,
    cancel_at_period_end: !!org.stripe_cancel_at_period_end,
    has_customer: !!org.stripe_customer_id,
    has_subscription: !!org.stripe_subscription_id,
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    products,
    // Deploy #61: single access verdict for the client's paywall gate and
    // the server's plans-only backstop — 'plans_only' when nothing is
    // unlocked (trial over or canceled past its window, nothing paid).
    access: products.rcm || products.ai ? 'full' : 'plans_only',
    plans: {
      starter: { name: PLANS.starter.name, amount: PLANS.starter.amount, available: !!PLANS.starter.priceId },
      pro: { name: PLANS.pro.name, amount: PLANS.pro.amount, available: !!PLANS.pro.priceId },
      ai: { name: PLANS.ai.name, amount: PLANS.ai.amount, available: !!PLANS.ai.priceId },
    },
  };
}

// ---- GET /api/billing/status — current plan for this org ----
router.get('/status', authRequired, (req, res) => {
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const out = billingStatusFor(org);
  // Super-admin (deploy #54): free and unrestricted — always enterprise/active.
  if (req.isSuperAdmin) {
    out.plan = 'enterprise';
    out.plan_status = 'active';
    out.is_trialing = false;
    out.trial_days_left = 0;
    out.products = { rcm: true, ai: true };
    out.unlimited = true;
  }
  res.json(out);
});

// ---- GET /api/billing/usage — plan usage vs limits (powers usage bars + 80% banner) ----
router.get('/usage', authRequired, (req, res) => {
  const { usageForOrg } = require('../usage');
  res.json(usageForOrg(req.orgId));
});

// ---- POST /api/billing/checkout — create a Checkout session (owner only) ----
router.post('/checkout', authRequired, roleRequired('owner'), async (req, res) => {
  if (!billingConfigured(res)) return;
  // HIPAA gate: a signed BAA is required before a paid subscription can be activated
  if (!baaSignedForOrg(req.orgId)) {
    return res.status(403).json({
      error: 'BAA_REQUIRED',
      message: 'Please sign the Business Associate Agreement first — it is required before activating a paid subscription. Go to Settings → Compliance.',
    });
  }
  const stripe = getStripe();
  const { plan } = req.body || {};
  const planCfg = PLANS[plan];
  if (!planCfg) return res.status(400).json({ error: 'Unknown plan. Choose starter, pro, or ai.' });
  if (!planCfg.priceId) {
    return res.status(503).json({ error: `${planCfg.name} is not priced yet. Run scripts/setup-stripe.js first.` });
  }

  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (org.stripe_subscription_id && org.plan_status === 'active' && org.plan === plan) {
    return res.status(400).json({ error: `You are already on ${planCfg.name}.` });
  }
  // App-side trial: no card was taken, so carry the remaining trial days into
  // Stripe — billing starts exactly when the 30-day trial ends. Expired or no
  // trial => charge starts immediately.
  const trial_period_days = getTrialPeriodDays(org);

  try {
    const customer = await getOrCreateCustomer(stripe, org, req.user.email);
    const appUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
    // AI-only buyers land in the AI app, not the RCM dashboard
    const landingPath = plan === 'ai' ? '/ai/app/' : '/app/';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: planCfg.priceId, quantity: 1 }],
      success_url: `${appUrl}${landingPath}?billing=success&plan=${plan}`,
      cancel_url: `${appUrl}${landingPath}?billing=cancelled`,
      metadata: { org_id: String(org.id), plan },
      subscription_data: {
        metadata: { org_id: String(org.id), plan },
        ...(trial_period_days > 0 ? { trial_period_days } : {}),
      },
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---- POST /api/billing/portal — Customer Portal session (owner only) ----
router.post('/portal', authRequired, roleRequired('owner'), async (req, res) => {
  if (!billingConfigured(res)) return;
  const stripe = getStripe();
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (!org.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing account yet. Choose a plan first.' });
  }
  try {
    const appUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${appUrl}/app/?billing=portal`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe portal error:', e.message);
    res.status(502).json({ error: 'Could not open the billing portal. Please try again.' });
  }
});

// ---- POST /api/billing/cancel — self-serve cancellation (owner only) ----
// Deploy #54: any customer can cancel at any time, in-app. Default mode is
// 'period_end' (Stripe cancel_at_period_end — access continues until the
// paid period ends, then the subscription.deleted webhook closes the org).
// 'immediate' cancels in Stripe right now. Deploy #61: during the trial,
// both modes schedule the end AT the trial end date instead (see below).
router.post('/cancel', authRequired, roleRequired('owner'), async (req, res) => {
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (getEffectivePlanStatus(org) === 'canceled') {
    return res.status(400).json({ error: 'This subscription is already canceled.' });
  }
  const mode = req.body?.mode === 'immediate' ? 'immediate' : 'period_end';

  // Deploy #61: canceling DURING the trial never truncates it — access runs
  // to the trial end date and the plan simply doesn't convert (Stripe/SaaS
  // norm). This holds for both modes and both trial flavors; the requested
  // mode only matters for paid subscriptions below.
  if (getEffectivePlanStatus(org) === 'trialing') {
    const endDate = org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : 'the trial end date';
    if (org.stripe_cancel_at_period_end) {
      return res.status(400).json({ error: `Your trial is already set to end on ${endDate} without converting.` });
    }
    if (org.stripe_subscription_id) {
      if (!billingConfigured(res)) return;
      const stripe = getStripe();
      try {
        // On a trialing subscription this ends it AT the trial end, no charge.
        await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: true });
      } catch (e) {
        console.error('Stripe trial cancel error:', e.message);
        return res.status(502).json({ error: 'Stripe could not schedule the cancellation. Please try again or contact support.' });
      }
    }
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 1 WHERE id = ?').run(org.id);
    return res.json({
      ok: true, mode: 'trial_end', access_until: org.trial_ends_at,
      message: `Your trial will end on ${endDate} and won't convert to a paid plan — you keep full access until then. Changed your mind? Use "Keep my plan" anytime before then.`,
    });
  }

  if (!org.stripe_subscription_id) {
    db.prepare("UPDATE orgs SET plan_status = 'canceled', stripe_cancel_at_period_end = 0 WHERE id = ?").run(org.id);
    return res.json({ ok: true, mode: 'immediate', access_until: null, message: 'Your subscription has been ended. Thanks for trying ClaimPaid.' });
  }
  if (!billingConfigured(res)) return;
  const stripe = getStripe();
  try {
    if (mode === 'immediate') {
      await stripe.subscriptions.cancel(org.stripe_subscription_id);
      db.prepare("UPDATE orgs SET plan_status = 'canceled', stripe_subscription_id = NULL, stripe_cancel_at_period_end = 0 WHERE id = ?").run(org.id);
      return res.json({ ok: true, mode, access_until: null, message: 'Your subscription is canceled, effective immediately.' });
    }
    const sub = await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: true });
    const until = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : (org.current_period_end || null);
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 1, current_period_end = COALESCE(?, current_period_end) WHERE id = ?')
      .run(until, org.id);
    return res.json({ ok: true, mode, access_until: until, message: `Your subscription will cancel on ${until ? until.slice(0, 10) : 'the period end'} — you keep full access until then.` });
  } catch (e) {
    console.error('Stripe cancel error:', e.message);
    return res.status(502).json({ error: 'Stripe could not cancel the subscription. Please try again or contact support.' });
  }
});

// ---- POST /api/billing/reactivate — undo a scheduled cancel (owner only) ----
router.post('/reactivate', authRequired, roleRequired('owner'), async (req, res) => {
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (!org.stripe_cancel_at_period_end) {
    return res.status(400).json({ error: 'No scheduled cancellation to undo.' });
  }
  // App-side trial with no Stripe subscription: clearing the flag is a
  // purely local undo (deploy #61 — trial cancels schedule an end, they
  // don't create a subscription to reactivate).
  if (!org.stripe_subscription_id) {
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 0 WHERE id = ?').run(org.id);
    return res.json({ ok: true, message: 'Your trial will convert as planned — add a payment method before it ends to keep your plan.' });
  }
  if (!billingConfigured(res)) return;
  const stripe = getStripe();
  try {
    await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: false });
    db.prepare('UPDATE orgs SET stripe_cancel_at_period_end = 0 WHERE id = ?').run(org.id);
    return res.json({ ok: true, message: 'Your subscription will continue as normal.' });
  } catch (e) {
    console.error('Stripe reactivate error:', e.message);
    return res.status(502).json({ error: 'Stripe could not reactivate the subscription. Please try again or contact support.' });
  }
});

// ---- POST /api/billing/change-plan — switch plans (owner only) ----
// Deploy #60: before this, subscribe + cancel existed but there was NO way
// to move between plans — an AI-only buyer who wanted RCM (or a Starter
// team that wanted AI) hit a lockout wall, and the plan picker was hidden
// from active subscribers entirely. Three modes:
//   swapped  — a live Stripe subscription gets its price swapped in place
//              (proration_behavior create_prorations; a scheduled
//              cancellation is cleared — choosing a new plan means staying).
//              The subscription.updated webhook reconciles plan/status.
//   trial    — app-side trial with no card yet: the plan flips instantly,
//              trial clock untouched.
//   checkout — canceled/expired with no subscription: the client sends the
//              user through the normal checkout for the new plan.
router.post('/change-plan', authRequired, roleRequired('owner'), async (req, res) => {
  const { plan } = req.body || {};
  const planCfg = PLANS[plan];
  if (!planCfg) return res.status(400).json({ error: 'Unknown plan. Choose starter, pro, or ai.' });
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (org.plan === 'enterprise') {
    return res.status(400).json({ error: 'Enterprise plans are managed by ClaimPaid — contact support@claimpaid.io to make changes.' });
  }
  if (org.plan === plan) {
    return res.status(400).json({ error: `You are already on ${planCfg.name}.` });
  }
  const eff = getEffectivePlanStatus(org);

  if (org.stripe_subscription_id) {
    if (!billingConfigured(res)) return;
    if (!planCfg.priceId) {
      return res.status(503).json({ error: `${planCfg.name} is not priced yet. Run scripts/setup-stripe.js first.` });
    }
    const stripe = getStripe();
    try {
      const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
      const item = sub.items?.data?.[0];
      if (!item) return res.status(502).json({ error: 'Your subscription has no plan item to switch. Contact support@claimpaid.io.' });
      const updated = await stripe.subscriptions.update(org.stripe_subscription_id, {
        items: [{ id: item.id, price: planCfg.priceId }],
        proration_behavior: 'create_prorations',
        cancel_at_period_end: false,
        metadata: { ...(sub.metadata || {}), org_id: String(org.id), plan },
      });
      db.prepare(`UPDATE orgs SET plan = ?, plan_status = ?,
                  stripe_cancel_at_period_end = 0,
                  current_period_end = COALESCE(?, current_period_end) WHERE id = ?`)
        .run(plan, updated.status || org.plan_status,
             updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null,
             org.id);
      const trialing = updated.status === 'trialing';
      return res.json({
        ok: true, mode: 'swapped', plan,
        message: trialing
          ? `You're now on ${planCfg.name} — your free trial still ends ${org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : 'on schedule'}, and billing adjusts from then.`
          : `You're now on ${planCfg.name}. Stripe prorated the switch — the difference lands on your next invoice.`,
      });
    } catch (e) {
      console.error('Stripe change-plan error:', e.message);
      return res.status(502).json({ error: 'Stripe could not switch your plan. Please try again or contact support.' });
    }
  }

  if (eff === 'trialing') {
    db.prepare('UPDATE orgs SET plan = ? WHERE id = ?').run(plan, org.id);
    return res.json({
      ok: true, mode: 'trial', plan,
      message: `You're now trialing ${planCfg.name} — same trial end date, no charge.`,
    });
  }

  return res.json({
    ok: false, mode: 'checkout', plan,
    message: `To move to ${planCfg.name}, complete checkout for the new plan.`,
  });
});

// ---- GET /api/billing/invoices — last 12 invoices (owner only) ----
router.get('/invoices', authRequired, roleRequired('owner'), async (req, res) => {
  const stripe = getStripe();
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  // Graceful when billing isn't set up: the UI hides the section
  if (!stripe || !org.stripe_customer_id) return res.json({ invoices: [] });
  try {
    const list = await stripe.invoices.list({ customer: org.stripe_customer_id, limit: 12 });
    res.json({
      invoices: (list.data || []).map((inv) => ({
        number: inv.number || inv.id,
        date: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        amount: inv.amount_due ?? inv.amount_paid ?? 0,
        currency: (inv.currency || 'usd').toUpperCase(),
        status: inv.status,
        pdf: inv.invoice_pdf || null,
      })),
    });
  } catch (e) {
    console.error('Stripe invoices error:', e.message);
    res.status(502).json({ error: 'Could not load invoices. Please try again.' });
  }
});

// ---- Webhook handler (mounted with express.raw in index.js) ----
async function handleWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe) return res.status(503).send('Billing not configured');
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).send('Webhook secret not configured');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    console.error('Stripe webhook signature failed:', e.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed' && event.data.object?.metadata?.statement_id) {
      // Patient statement payment (deploy #50): a Payment Link checkout
      // carrying statement metadata. Settled through the same allocation
      // the manual-payment path uses; external id makes redelivery safe.
      const session = event.data.object;
      const stmtId = Number(session.metadata.statement_id);
      const stmtOrgId = Number(session.metadata.org_id);
      const amount = (Number(session.amount_total) || 0) / 100;
      try {
        const core = require('../statements-core');
        const stmtRow = db.prepare('SELECT id FROM patient_statements WHERE id = ? AND org_id = ?').get(stmtId, stmtOrgId);
        if (stmtRow && amount > 0) {
          core.recordPayment(db, {
            orgId: stmtOrgId, statementId: stmtId, amount, method: 'stripe',
            externalId: `stripe:${session.payment_intent || session.id}`,
          });
          console.log(`Billing: statement ${stmtId} payment $${amount.toFixed(2)} via Stripe`);
        }
      } catch (e) {
        console.error('Statement webhook settle failed:', e.message);
      }
      return res.json({ received: true });
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orgId = Number(session.metadata?.org_id);
      const plan = session.metadata?.plan;
      if (orgId && plan && PLANS[plan]) {
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
        // Use the subscription's real status: 'trialing' when a free trial was taken
        let planStatus = 'active';
        let trialEndsAt = null;
        if (subscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            planStatus = sub.status;
            // Keep the app trial clock in sync with Stripe's so both agree
            if (sub.trial_end) trialEndsAt = new Date(sub.trial_end * 1000).toISOString();
          } catch (e) { console.error('Billing: could not fetch subscription status:', e.message); }
        }
        db.prepare(`UPDATE orgs SET plan = ?, plan_status = ?,
                    trial_ends_at = COALESCE(?, trial_ends_at),
                    stripe_cancel_at_period_end = 0,
                    stripe_customer_id = COALESCE(stripe_customer_id, ?),
                    stripe_subscription_id = ? WHERE id = ?`)
          .run(plan, planStatus, trialEndsAt, String(session.customer), subscriptionId || null, orgId);
        console.log(`Billing: org ${orgId} subscribed to ${plan} (${planStatus})`);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const orgId = Number(sub.metadata?.org_id);
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planFromPriceId(priceId) || sub.metadata?.plan;
      if (orgId) {
        const trialEndsAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
        db.prepare(`UPDATE orgs SET plan = COALESCE(?, plan), plan_status = ?,
                    trial_ends_at = COALESCE(?, trial_ends_at),
                    current_period_end = ?, stripe_subscription_id = ? WHERE id = ?`)
          .run(plan || null, sub.status, trialEndsAt,
               sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
               sub.id, orgId);
        console.log(`Billing: org ${orgId} subscription updated -> ${sub.status}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const orgId = Number(sub.metadata?.org_id);
      if (orgId) {
        db.prepare(`UPDATE orgs SET plan_status = 'canceled', stripe_subscription_id = NULL WHERE id = ?`)
          .run(orgId);
        console.log(`Billing: org ${orgId} subscription canceled`);
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook handler error:', e.message);
    res.status(500).send('Webhook handler failed');
  }
}

// ---- Connect webhook handler (mounted with express.raw in index.js) ----
// Patient statement payments settle on the PRACTICE's connected account,
// so their checkout.session.completed events arrive on this separate
// Connect endpoint with its own signing secret. event.account identifies
// the connected account; the session metadata carries statement_id/org_id
// (set at link creation in statements-core). Settlement goes through the
// same recordPayment allocation as the manual-payment route and the
// platform webhook; idempotency is recordPayment's external-id guard
// (statement_payments.external_id is UNIQUE — a redelivered event finds
// the existing `stripe:<payment_intent|session>` row and no-ops).
async function handleConnectWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(503).json({ error: 'connect webhook not configured' });
  const stripe = getStripe();
  if (!stripe) return res.status(503).send('Billing not configured');
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    console.error('Stripe Connect webhook signature failed:', e.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed' && event.data.object?.metadata?.statement_id) {
      const session = event.data.object;
      const stmtId = Number(session.metadata.statement_id);
      const stmtOrgId = Number(session.metadata.org_id);
      const amount = (Number(session.amount_total) || 0) / 100;
      // Defense in depth: only settle when the event's connected account
      // is the account this org actually linked — an event naming another
      // account must never move this org's statements.
      const org = stmtOrgId
        ? db.prepare('SELECT stripe_account_id FROM orgs WHERE id = ?').get(stmtOrgId)
        : null;
      try {
        const core = require('../statements-core');
        const stmtRow = db.prepare('SELECT id FROM patient_statements WHERE id = ? AND org_id = ?').get(stmtId, stmtOrgId);
        if (stmtRow && org && event.account && org.stripe_account_id === event.account && amount > 0) {
          core.recordPayment(db, {
            orgId: stmtOrgId, statementId: stmtId, amount, method: 'stripe',
            externalId: `stripe:${session.payment_intent || session.id}`,
          });
          console.log(`Billing(Connect): statement ${stmtId} payment $${amount.toFixed(2)} via Stripe`);
        }
      } catch (e) {
        console.error('Connect statement settle failed:', e.message);
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe Connect webhook handler error:', e.message);
    res.status(500).send('Webhook handler failed');
  }
}

module.exports = { billingRoutes: router, handleWebhook, handleConnectWebhook, PLANS, productsForPlan, productsForOrg, getEffectivePlanStatus, getTrialPeriodDays, billingStatusFor };
