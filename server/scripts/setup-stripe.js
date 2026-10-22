// Creates the ClaimPaid products + recurring prices in Stripe via API.
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js
// Prints the STRIPE_PRICE_* lines to add to server/.env (safe to re-run).
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('Set STRIPE_SECRET_KEY first (use a sk_test_ key to try it safely).');
  process.exit(1);
}
const stripe = require('stripe')(stripeKey);

const PRODUCTS = [
  { key: 'STARTER', name: 'ClaimPaid RCM Starter', amount: 19900,
    desc: 'Full RCM platform for small billing teams. $199/month.' },
  { key: 'PRO', name: 'ClaimPaid RCM Pro + AI', amount: 49900,
    desc: 'Everything in Starter plus the ClaimPaid AI assistant. $499/month.' },
];

async function ensureProduct(cfg) {
  const existing = await stripe.products.search({ query: `name:'${cfg.name}'`, limit: 1 });
  let product = existing.data[0];
  if (!product) {
    product = await stripe.products.create({ name: cfg.name, description: cfg.desc });
    console.log(`  created product ${product.id}`);
  } else {
    console.log(`  product exists ${product.id}`);
  }
  const prices = await stripe.prices.list({ product: product.id, limit: 10 });
  let price = prices.data.find((p) => p.unit_amount === cfg.amount && p.recurring?.interval === 'month' && p.active);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: cfg.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: `${cfg.name} monthly`,
    });
    console.log(`  created price ${price.id} ($${(cfg.amount / 100).toFixed(0)}/mo)`);
  } else {
    console.log(`  price exists ${price.id}`);
  }
  return price.id;
}

(async () => {
  console.log('Setting up ClaimPaid products in Stripe…');
  const out = {};
  for (const cfg of PRODUCTS) {
    console.log(cfg.name);
    out[cfg.key] = await ensureProduct(cfg);
  }
  console.log('\nAdd these to server/.env:');
  console.log(`STRIPE_PRICE_STARTER=${out.STARTER}`);
  console.log(`STRIPE_PRICE_PRO=${out.PRO}`);
})().catch((e) => { console.error('Stripe setup failed:', e.message); process.exit(1); });
