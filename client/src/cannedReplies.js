// Canned support replies — inserted into the super-admin ticket composer.
// Written in the founder's support voice: lead with the answer, no fluff,
// 3–5 sentences max, short phone-readable paragraphs, ends with exactly one
// next step or one question, signed "— The ClaimPaid Support Team". Sendable as-is.
export const CANNED_REPLIES = [
  {
    id: 'trial',
    title: 'Free trial question',
    body: `Every plan starts with a 30-day free trial — no credit card required. Pick a plan during onboarding and the trial starts immediately.

How many claims does your team handle per month? I can tell you which plan fits.

— The ClaimPaid Support Team`,
  },
  {
    id: 'billing',
    title: 'Billing / pricing question',
    body: `Here's the breakdown: Starter $199/mo, Pro + AI $499/mo, AI-only $99/mo, Enterprise custom. Every plan starts with a 30-day free trial, no card required.

Upgrade, downgrade, or cancel from the Billing tab any time — nothing locks you in. Want a recommendation based on your claim volume?

— The ClaimPaid Support Team`,
  },
  {
    id: 'ehr',
    title: 'EHR connection (athenahealth)',
    body: `We connect to athenahealth: go to Settings → EHR and follow the steps. Takes about two minutes, and visit data flows in automatically after.

Heads up: we don't do Epic. I'd rather tell you that now than waste your time. Are you on athenahealth today?

— The ClaimPaid Support Team`,
  },
  {
    id: 'eligibility',
    title: 'Eligibility setup',
    body: `Go to Settings → Eligibility and add your vendor credentials — we support custom REST vendors, and there's a demo mode to try the workflow first.

Checks only go live once your vendor account is connected on your end. Which vendor are you using?

— The ClaimPaid Support Team`,
  },
  {
    id: 'transmission',
    title: '837P transmission setup',
    body: `ClaimPaid generates real 837P files (005010X222A1) with a built-in validator, so what you send is clean. Go to Claims → Transmission and pick manual download, SFTP, or a REST adapter to your clearinghouse.

Which clearinghouse do you submit through?

— The ClaimPaid Support Team`,
  },
  {
    id: 'baa',
    title: 'BAA request',
    body: `You can review and e-sign our BAA right in the app under Settings. Takes about a minute.

Is there anything specific your compliance team needs in it?

— The ClaimPaid Support Team`,
  },
  {
    id: 'login',
    title: 'Login / password trouble',
    body: `Use the "Forgot password" link on the login page — the reset email arrives within a few minutes (check spam). If you're locked out after too many attempts, the lock clears on its own after 15 minutes.

Still stuck after that? Tell me exactly what you see on screen.

— The ClaimPaid Support Team`,
  },
  {
    id: 'import',
    title: 'Importing existing claims',
    body: `Go to Claims → Import and grab the CSV template so the columns line up. Every imported claim runs through our 15-rule scrubber before it hits your worklist.

Roughly how many claims are you importing?

— The ClaimPaid Support Team`,
  },
  {
    id: 'cancel',
    title: 'Cancelling subscription',
    body: `No hard feelings. Go to Billing → Manage billing to cancel — your data stays put and you can reactivate any time.

What wasn't working for you? It helps us get better.

— The ClaimPaid Support Team`,
  },
  {
    id: 'security',
    title: 'Security / compliance question',
    body: `All traffic is TLS-encrypted, backups are encrypted the moment they're written, access is role-based with optional MFA, and sensitive actions are audit-logged. Our AI runs on our own server — your data never goes to a third-party AI API. We also offer BAA e-signing in the app.

Is there a specific requirement your team needs covered?

— The ClaimPaid Support Team`,
  },
];
