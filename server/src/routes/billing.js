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
  _stripe = require('stripe')(key);
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

// Products for an org, honoring trial expiry: an expired trial unlocks nothing.
function productsForOrg(org) {
  if (getEffectivePlanStatus(org) === 'expired') return { rcm: false, ai: false };
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
  return {
    plan: org.plan || 'trial',
    plan_status: effStatus,
    trial_ends_at: trialEndsAt,
    trial_days_left: msLeft > 0 ? Math.ceil(msLeft / 86400000) : 0,
    is_trialing: effStatus === 'trialing',
    current_period_end: org.current_period_end || null,
    has_customer: !!org.stripe_customer_id,
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    products: productsForOrg(org),
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
  res.json(billingStatusFor(org));
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

module.exports = { billingRoutes: router, handleWebhook, PLANS, productsForPlan, productsForOrg, getEffectivePlanStatus, getTrialPeriodDays, billingStatusFor };
