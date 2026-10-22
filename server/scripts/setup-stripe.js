// Creates the ClaimPaid products + recurring prices in Stripe via API.
// Uses direct HTTPS calls (the Stripe SDK's keep-alive agent trips over this
// sandbox's egress proxy; on the production VPS the SDK works normally).
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js
// Prints the STRIPE_PRICE_* lines to add to server/.env (safe to re-run).
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('Set STRIPE_SECRET_KEY first (use a sk_test_ key to try it safely).');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2025-08-27.basil',
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${data.error?.message || res.status}`);
  return data;
}

const PRODUCTS = [
  { key: 'STARTER', name: 'ClaimPaid RCM Starter', amount: 19900,
    desc: 'Full RCM platform for small billing teams. $199/month.' },
  { key: 'PRO', name: 'ClaimPaid RCM Pro + AI', amount: 49900,
    desc: 'Everything in Starter plus the ClaimPaid AI assistant. $499/month.' },
];

async function ensureProduct(cfg) {
  const found = await api('GET', `/v1/products/search?query=name%3A%27${encodeURIComponent(cfg.name)}%27&limit=1`);
  let product = found.data[0];
  if (!product) {
    product = await api('POST', '/v1/products', {
      name: cfg.name, description: cfg.desc,
      tax_code: 'txcd_10103000', // SaaS — required when Stripe Managed Payments is on
    });
    console.log(`  created product ${product.id}`);
  } else {
    console.log(`  product exists ${product.id}`);
  }
  const prices = await api('GET', `/v1/prices?product=${product.id}&limit=10`);
  let price = prices.data.find((p) => p.unit_amount === cfg.amount && p.recurring?.interval === 'month' && p.active);
  if (!price) {
    price = await api('POST', '/v1/prices', {
      product: product.id,
      unit_amount: String(cfg.amount),
      currency: 'usd',
      'recurring[interval]': 'month',
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
