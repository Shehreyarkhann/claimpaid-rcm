const express = require('express');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');

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
};

function planFromPriceId(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
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

// ---- GET /api/billing/status — current plan for this org ----
router.get('/status', authRequired, (req, res) => {
  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  res.json({
    plan: org.plan || 'trial',
    plan_status: org.plan_status || 'trialing',
    current_period_end: org.current_period_end || null,
    has_customer: !!org.stripe_customer_id,
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    plans: {
      starter: { name: PLANS.starter.name, amount: PLANS.starter.amount, available: !!PLANS.starter.priceId },
      pro: { name: PLANS.pro.name, amount: PLANS.pro.amount, available: !!PLANS.pro.priceId },
    },
  });
});

// ---- POST /api/billing/checkout — create a Checkout session (owner only) ----
router.post('/checkout', authRequired, roleRequired('owner'), async (req, res) => {
  if (!billingConfigured(res)) return;
  const stripe = getStripe();
  const { plan } = req.body || {};
  const planCfg = PLANS[plan];
  if (!planCfg) return res.status(400).json({ error: 'Unknown plan. Choose starter or pro.' });
  if (!planCfg.priceId) {
    return res.status(503).json({ error: `${planCfg.name} is not priced yet. Run scripts/setup-stripe.js first.` });
  }

  const org = getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  if (org.stripe_subscription_id && org.plan_status === 'active' && org.plan === plan) {
    return res.status(400).json({ error: `You are already on ${planCfg.name}.` });
  }

  try {
    const customer = await getOrCreateCustomer(stripe, org, req.user.email);
    const appUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: planCfg.priceId, quantity: 1 }],
      success_url: `${appUrl}/app/?billing=success&plan=${plan}`,
      cancel_url: `${appUrl}/app/?billing=cancelled`,
      metadata: { org_id: String(org.id), plan },
      subscription_data: { metadata: { org_id: String(org.id), plan } },
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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orgId = Number(session.metadata?.org_id);
      const plan = session.metadata?.plan;
      if (orgId && plan && PLANS[plan]) {
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;
        db.prepare(`UPDATE orgs SET plan = ?, plan_status = 'active',
                    stripe_customer_id = COALESCE(stripe_customer_id, ?),
                    stripe_subscription_id = ? WHERE id = ?`)
          .run(plan, String(session.customer), subscriptionId || null, orgId);
        console.log(`Billing: org ${orgId} subscribed to ${plan}`);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const orgId = Number(sub.metadata?.org_id);
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planFromPriceId(priceId) || sub.metadata?.plan;
      if (orgId) {
        db.prepare(`UPDATE orgs SET plan = COALESCE(?, plan), plan_status = ?,
                    current_period_end = ?, stripe_subscription_id = ? WHERE id = ?`)
          .run(plan || null, sub.status,
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

module.exports = { billingRoutes: router, handleWebhook, PLANS };
