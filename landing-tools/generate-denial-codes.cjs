#!/usr/bin/env node
/**
 * generate-denial-codes.cjs — Deploy #103 denial code library generator.
 *
 * Emits static HTML for the ClaimPaid landing from editorial data files:
 *   <data>/denial-codes.json     — one entry per CARC (meaning, causes,
 *                                  fix steps, route, FAQ) — edit THIS to
 *                                  extend the library.
 *   <data>/payer-deadlines.json  — timely-filing windows per payer.
 *
 * Output (into <out>, the claimpilot landing source of truth):
 *   denial-codes/index.html            — searchable/filterable index
 *   denial-codes/<slug>/index.html     — one page per code
 *   deadlines/index.html               — payer deadline hub
 *
 * Deterministic: no timestamps beyond the `meta.updated` value stored in
 * the data files; re-running produces byte-identical output.
 *
 * Usage:
 *   node landing-tools/generate-denial-codes.cjs [--data DIR] [--out DIR]
 * Defaults: --data ~/workspace/claimpilot/landing-data
 *           --out  ~/workspace/claimpilot/landing
 * After generating, mirror the landing tree into rcm-dashboard/landing.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argVal(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const DATA_DIR = argVal('--data', path.join(process.env.HOME, 'workspace/claimpilot/landing-data'));
const OUT_DIR = argVal('--out', path.join(process.env.HOME, 'workspace/claimpilot/landing'));

const codesData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'denial-codes.json'), 'utf8'));
const deadlinesData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'payer-deadlines.json'), 'utf8'));
const CODES = codesData.codes;
const UPDATED = codesData.meta.updated;
const UPDATED_HUMAN = 'October 29, 2026';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (obj) => '<script type="application/ld+json">\n' + JSON.stringify(obj) + '\n</script>';

const CATEGORY_ORDER = ['contractual', 'medical-necessity', 'eligibility', 'coding', 'timely-filing', 'authorization', 'other'];
const CATEGORY_LABELS = {
  contractual: 'Contractual adjustments',
  'medical-necessity': 'Medical necessity',
  eligibility: 'Eligibility & coverage',
  coding: 'Coding & claim data',
  'timely-filing': 'Timely filing',
  authorization: 'Authorization',
  other: 'Other adjustments',
};

const HEAD_CSS = `<style>
:root{--paper:#FAF5EB;--paper2:#F3ECDC;--card:#FFFDF8;--ink:#211A13;--ink2:#453B2F;--mut:#7C7060;--line:#E4D9C3;--green:#0E9F6E;--green-dk:#0A7A54;--green-deep:#17251F;--amber:#B45309;--amber-lt:#D97706;--amber-bg:#FBF3E4;--mint-bg:#EFFAF4;--red:#B3261E;--red-bg:#FBEBE9}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--paper);color:var(--ink2);font-family:'Inter',system-ui,sans-serif;line-height:1.75;font-size:16.5px}
h1,h2,h3{font-family:'Fraunces',Georgia,serif;line-height:1.25;color:var(--ink)}
.wrap{max-width:820px;margin:0 auto;padding:0 24px}
.wrap-wide{max-width:1100px;margin:0 auto;padding:0 24px}
nav{position:fixed;top:0;left:0;right:0;z-index:50;backdrop-filter:blur(14px);background:rgba(250,245,235,.88);border-bottom:1px solid var(--line)}
.nav-in{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:68px}
.logo{display:flex;align-items:center;gap:10px;font-family:'Playfair Display',Georgia,serif;font-weight:800;font-size:21px;letter-spacing:-.4px;text-decoration:none;color:var(--ink)}
.logo img{width:34px;height:34px;border-radius:9px;box-shadow:0 4px 14px rgba(14,159,110,.35)}
.logo .wm{color:var(--ink)} .logo em{font-style:normal;color:var(--green-dk)}
.nav-links{display:flex;gap:28px;align-items:center}
.nav-links a{color:var(--ink2);text-decoration:none;font-size:14.5px;font-weight:500}
.nav-links a:hover{color:var(--ink)}
.btn{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:15px;border-radius:12px;padding:13px 26px;text-decoration:none;border:none;transition:transform .25s,box-shadow .25s;cursor:pointer;font-family:'Inter',sans-serif}
.btn-green{background:#0E9F6E;color:#fff;box-shadow:0 8px 24px rgba(14,159,110,.32)}
.btn-green:hover{transform:translateY(-3px)}
.btn-sm{padding:10px 20px;font-size:14px;color:#fff}
.btn-ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
article{padding:132px 0 60px}
.crumb{font-size:13px;color:var(--mut);margin-bottom:18px}
.crumb a{color:var(--green-dk);text-decoration:none;font-weight:600}
.tag{display:inline-block;font-size:11.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--green-dk);background:var(--mint-bg);border:1px solid #BFE8D6;padding:5px 12px;border-radius:100px;margin-bottom:18px}
article h1{font-size:clamp(31px,4.4vw,45px);font-weight:800;letter-spacing:-1px;margin-bottom:14px;line-height:1.15}
.byline{color:var(--mut);font-size:14px;margin-bottom:34px}
.prose h2{font-size:27px;font-weight:700;letter-spacing:-.5px;margin:46px 0 16px}
.prose h3{font-size:19px;font-weight:700;margin:28px 0 10px}
.prose p{margin:0 0 18px}
.prose ul,.prose ol{margin:0 0 20px 22px}
.prose li{margin-bottom:10px}
.prose strong{color:var(--ink)}
.prose a{color:var(--green-dk);text-decoration:underline;text-underline-offset:3px;font-weight:600}
table{width:100%;border-collapse:separate;border-spacing:0;margin:26px 0;font-size:14.5px;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th{background:var(--paper2);color:var(--ink);text-align:left;padding:13px 15px;font-family:'Fraunces',Georgia,serif;font-size:14.5px;font-weight:700;border-bottom:1px solid var(--line)}
td{padding:12px 15px;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:none}
td strong{color:var(--ink)}
.note{font-size:14.5px;background:var(--amber-bg);border:1px solid #EBD9B4;border-left:4px solid var(--amber-lt);border-radius:14px;padding:18px 22px;margin:26px 0}
.note strong{color:var(--ink)}
.route{background:var(--mint-bg);border:1px solid #BFE8D6;border-left:4px solid var(--green);border-radius:14px;padding:18px 22px;margin:26px 0;font-size:15px}
.route strong{color:var(--ink)}
.cta-band{background:var(--green-deep);border-radius:18px;padding:34px 36px;margin:48px 0 8px;color:#E9E2D0}
.cta-band h2{color:#FBF7EC;font-size:26px;margin:0 0 10px}
.cta-band p{margin:0 0 20px;color:#CFC6AC}
.cta-band .row{display:flex;gap:14px;flex-wrap:wrap}
.rel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin:20px 0 8px}
.rel-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;text-decoration:none;transition:transform .2s,border-color .2s}
.rel-card:hover{transform:translateY(-2px);border-color:var(--green)}
.rel-card .rc{font-family:'Fraunces',Georgia,serif;font-weight:800;font-size:18px;color:var(--ink)}
.rel-card .rt{font-size:13.5px;color:var(--mut);line-height:1.5;margin-top:4px}
footer{border-top:1px solid var(--line);padding:40px 0;color:var(--mut);font-size:13.5px;background:var(--paper)}
.foot{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:18px}
.foot a{color:var(--ink2);text-decoration:none}
.foot a:hover{color:var(--green-dk)}
.foot-links{display:flex;gap:22px;flex-wrap:wrap}
.lib-tools{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0 8px}
.lib-search{flex:1;min-width:240px;font:inherit;font-size:15px;padding:13px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink)}
.chip{font:inherit;font-size:13.5px;font-weight:600;padding:9px 16px;border-radius:100px;border:1px solid var(--line);background:var(--card);color:var(--ink2);cursor:pointer}
.chip[aria-pressed="true"]{background:var(--green-deep);color:#FBF7EC;border-color:var(--green-deep)}
.cat-block{margin-top:42px}
.cat-block h2{font-size:25px;margin-bottom:6px}
.cat-block .cat-sub{color:var(--mut);font-size:14.5px;margin-bottom:18px}
.code-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.code-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;text-decoration:none;transition:transform .2s,border-color .2s}
.code-card:hover{transform:translateY(-2px);border-color:var(--green)}
.code-card .cc{font-family:'Fraunces',Georgia,serif;font-weight:800;font-size:21px;color:var(--ink)}
.code-card .ct{font-weight:600;color:var(--ink);font-size:15px;line-height:1.45;margin:3px 0 6px}
.code-card .cm{font-size:13.5px;color:var(--mut);line-height:1.55}
.no-results{display:none;color:var(--mut);margin-top:24px}
/* ===== CP shell 104: products menu ===== */
.np-wrap{position:relative;display:flex;align-items:center}
.np-btn{background:none;border:none;cursor:pointer;font-family:inherit;font-size:14.5px;font-weight:500;color:#453B2F;display:inline-flex;align-items:center;gap:7px;padding:10px 4px;min-height:44px;border-radius:8px}
.np-btn:hover{color:#211A13}
.np-caret{transition:transform .25s;flex-shrink:0}
.np-wrap.open .np-caret{transform:rotate(180deg)}
.np-menu{position:absolute;top:calc(100% + 10px);left:50%;transform:translate(-50%,8px);width:344px;max-width:calc(100vw - 32px);background:#FFFDF8;border:1px solid #D8CBAE;border-radius:18px;box-shadow:0 30px 70px rgba(33,26,19,.18);padding:10px;opacity:0;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility .18s;z-index:90;text-align:left}
.np-wrap.open .np-menu{opacity:1;visibility:visible;transform:translate(-50%,0)}
.np-item{display:flex;flex-direction:column;gap:2px;padding:11px 14px;border-radius:12px;text-decoration:none}
.np-item:hover,.np-item:focus-visible{background:rgba(14,159,110,.08)}
.nav-links .np-item::after{display:none}
.np-t{font-weight:600;color:#211A13;font-size:15px;display:flex;align-items:center;gap:9px;line-height:1.3}
.np-d{font-size:13px;color:#7C7060;line-height:1.45;font-weight:400}
.np-free{font-size:10px;font-weight:800;letter-spacing:.9px;color:#0A7A54;background:#DFF5EA;border:1px solid rgba(14,159,110,.5);padding:2.5px 8px;border-radius:100px;line-height:1.25;white-space:nowrap}
.np-sep{font-size:11px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#7C7060;padding:13px 14px 5px;border-top:1px solid #E4D9C3;margin-top:7px}
@media(max-width:760px){
  .np-wrap{display:block;width:100%}
  .np-btn{width:100%;justify-content:space-between;padding:14px 0;font-size:16px;min-height:50px;border-bottom:1px solid #E4D9C3;border-radius:0;color:#453B2F}
  .np-menu{position:static;transform:none;width:100%;max-width:none;background:transparent;border:none;box-shadow:none;padding:2px 0 10px;display:none;opacity:1;visibility:visible;transition:none}
  .np-wrap.open .np-menu{display:block;transform:none}
  .np-item{padding:12px 8px}
  .np-sep{padding-left:8px;padding-right:8px}
}
/* ===== CP shell 104: burger + mobile panel + responsive hardening ===== */
.burger{display:none;background:none;border:none;cursor:pointer;padding:10px;margin:-10px -10px -10px 0;z-index:60;min-width:44px;min-height:44px}
.burger span{display:block;width:24px;height:2.5px;background:#211A13;border-radius:2px;margin:5.5px auto;transition:transform .3s,opacity .3s}
body{overflow-x:hidden}
img,svg,video{max-width:100%}
@media(max-width:760px){
  .nav-links{position:fixed;top:68px;left:0;right:0;flex-direction:column;align-items:stretch;gap:0;background:rgba(250,245,235,.98);border-bottom:1px solid #E4D9C3;padding:8px 24px 22px;display:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);z-index:55;max-height:calc(100dvh - 68px);overflow-y:auto;box-shadow:0 24px 40px rgba(33,26,19,.12)}
  .nav-links.open{display:flex}
  .nav-links>a{display:block;padding:15px 0;font-size:16px;border-bottom:1px solid #E4D9C3;min-height:50px}
  .nav-links a.btn{margin-top:14px;text-align:center;justify-content:center;border-bottom:none}
  .burger{display:block}
  .burger.open span:nth-child(1){transform:translateY(8px) rotate(45deg)}
  .burger.open span:nth-child(2){opacity:0}
  .burger.open span:nth-child(3){transform:translateY(-8px) rotate(-45deg)}
  .foot{flex-direction:column;align-items:flex-start;gap:14px}
  .foot-links{gap:8px 18px}
  .foot-links a{display:inline-block;padding:7px 0}
  .cta-band{padding:26px 22px}
  .cta-band .btn{width:100%;justify-content:center}
  input:not([type="checkbox"]):not([type="radio"]),select,textarea{font-size:16px}
  .chip{min-height:44px;display:inline-flex;align-items:center}
  .lib-search{font-size:16px;min-height:50px}
  th,td{padding:10px 11px}
  table{font-size:13.5px}
}
.foot-links{flex-wrap:wrap;row-gap:10px}
.nav-links a.np-item{display:flex}
</style>`;

function headOpen({ title, description, canonical, extraLd }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<link rel="canonical" href="${canonical}"/>
<meta name="robots" content="index, follow, max-image-preview:large"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="ClaimPaid"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description)}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:image" content="https://claimpaid.io/claimpaid-icon.webp"/>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"/><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png"/><link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png"/><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
${extraLd}
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700;9..144,800;9..144,900&family=Playfair+Display:wght@800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
${HEAD_CSS}
<link rel="stylesheet" href="/consent.css"/>
</head>`;
}

const NAV = `<body>
<nav><div class="nav-in">
  <a class="logo" href="/"><img src="/claimpaid-icon.webp" alt="ClaimPaid logo"/><span class="wm">Claim<em>Paid</em></span></a>
  <div class="nav-links" id="navLinks">
    <div class="np-wrap">
      <button type="button" class="np-btn" aria-haspopup="true" aria-expanded="false">Products <svg class="np-caret" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="np-menu" role="menu" aria-label="Products">
        <a class="np-item" href="/#platform" role="menuitem"><span class="np-t">ClaimPaid RCM</span><span class="np-d">The denial-management platform</span></a>
        <a class="np-item" href="/#agent" role="menuitem"><span class="np-t">The Agent</span><span class="np-d">Works your denial queue and drafts the appeals</span></a>
        <a class="np-item" href="/ai/" role="menuitem"><span class="np-t">ClaimPaid AI</span><span class="np-d">Policy answers and coding, with citations</span></a>
        <div class="np-sep">Free tools</div>
        <a class="np-item" href="/audit/" role="menuitem"><span class="np-t">Deadline Audit <span class="np-free">FREE</span></span><span class="np-d">See which open claims are about to expire</span></a>
        <a class="np-item" href="/denial-codes/" role="menuitem"><span class="np-t">Denial Code Library <span class="np-free">FREE</span></span><span class="np-d">Every denial code — meaning, causes, fixes</span></a>
        <a class="np-item" href="/deadlines/" role="menuitem"><span class="np-t">Filing Deadlines <span class="np-free">FREE</span></span><span class="np-d">Timely-filing limits for every major payer</span></a>
      </div>
    </div>
    <a href="/#pricing">Pricing</a><a href="/blog/">Blog</a><a href="/compare/">Compare</a>
    <a class="btn btn-green btn-sm" href="/app/">Get started</a>
  </div>
  <button class="burger" id="burger" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>
</div></nav>`;

const NAV_JS = `/* CP nav 104: products menu — click, hover (desktop), Esc, outside click, keyboard */
(function () {
  var wraps = Array.prototype.slice.call(document.querySelectorAll('.np-wrap'));
  if (!wraps.length) return;
  var mq = window.matchMedia ? window.matchMedia('(hover:hover) and (min-width:761px)') : { matches: false };
  function setOpen(w, open) {
    w.classList.toggle('open', open);
    var b = w.querySelector('.np-btn');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function closeAll(except) {
    wraps.forEach(function (w) { if (w !== except) setOpen(w, false); });
  }
  wraps.forEach(function (w) {
    var btn = w.querySelector('.np-btn');
    if (!btn) return;
    var hoverOpened = false;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (hoverOpened && w.classList.contains('open')) return;
      var willOpen = !w.classList.contains('open');
      closeAll(w);
      setOpen(w, willOpen);
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(w, true);
        var f = w.querySelector('.np-menu a');
        if (f) f.focus();
      }
    });
    w.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { setOpen(w, false); btn.focus(); }
    });
    w.addEventListener('focusout', function (e) {
      if (!w.contains(e.relatedTarget)) setOpen(w, false);
    });
    if (mq.matches) {
      w.addEventListener('mouseenter', function () { closeAll(w); setOpen(w, true); hoverOpened = true; });
      w.addEventListener('mouseleave', function () { hoverOpened = false; setOpen(w, false); });
    }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.np-wrap')) closeAll(null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAll(null);
  });
})();
/* CP nav 104: mobile hamburger (blog-shell pages; home has its own binding) */
(function () {
  var b = document.getElementById('burger'), l = document.getElementById('navLinks');
  if (!b || !l) return;
  b.addEventListener('click', function () {
    var open = l.classList.toggle('open');
    b.classList.toggle('open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  l.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      l.classList.remove('open');
      b.classList.remove('open');
      b.setAttribute('aria-expanded', 'false');
    });
  });
})();
`;

const FOOTER = `<footer><div class="foot">
  <a class="logo" href="/" style="font-size:17px"><img src="/claimpaid-icon.webp" alt="ClaimPaid logo" style="width:28px;height:28px"/><span class="wm">Claim<em>Paid</em></span></a>
  <div class="foot-links"><a href="/blog/">Blog</a><a href="/denial-codes/">Denial Code Library</a><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="/cookies/">Cookies</a><a href="/cookies/" data-cp-consent-open>Cookie settings</a><a href="mailto:support@claimpaid.io">support@claimpaid.io</a></div>
  <div>© 2026 ClaimPaid · Get your claims paid.</div>
</div></footer>
<script>
${NAV_JS}</script>
<script src="/consent.js" defer></script>
</body>
</html>`;

function ctaBand() {
  return `<div class="cta-band">
    <h2>Deadlines decide which denials are worth fighting</h2>
    <p>Every fix on this page runs against a filing or appeal clock. Run the free deadline audit on your open claims — in your browser, nothing uploaded — and see what is about to expire.</p>
    <div class="row"><a class="btn btn-green" href="/audit/">Run the free deadline audit →</a><a class="btn btn-ghost" href="/app/">Start the free trial</a></div>
  </div>`;
}

/* ---------------- per-code pages ---------------- */
function codePage(c) {
  const url = `https://claimpaid.io/denial-codes/${c.slug}/`;
  const title = `${c.code} Denial Code: ${c.title} — Meaning & Fix`;
  const description = `${c.code} (${c.group_label}) means: ${c.meaning.split('. ')[0]}. What it means on a remittance, the common causes, and how to fix or appeal it.`;
  const articleLd = ld({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: `${c.code} Denial Code: ${c.title}`,
    datePublished: '2026-10-29', dateModified: UPDATED,
    author: { '@type': 'Organization', name: 'ClaimPaid', url: 'https://claimpaid.io/' },
    publisher: { '@type': 'Organization', name: 'ClaimPaid', url: 'https://claimpaid.io/', logo: { '@type': 'ImageObject', url: 'https://claimpaid.io/claimpaid-icon.webp' } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    description,
  });
  const faqLd = ld({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: c.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });
  const crumbLd = ld({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://claimpaid.io/' },
      { '@type': 'ListItem', position: 2, name: 'Denial Code Library', item: 'https://claimpaid.io/denial-codes/' },
      { '@type': 'ListItem', position: 3, name: c.code, item: url },
    ],
  });
  const related = CODES.filter((o) => o.category === c.category && o.slug !== c.slug).slice(0, 6);
  const relatedHtml = related.length
    ? `<h2>Related codes — ${esc(c.category_label)}</h2>
  <div class="rel-grid">${related.map((r) => `<a class="rel-card" href="/denial-codes/${r.slug}/"><div class="rc">${esc(r.code)}</div><div class="rt">${esc(r.title)}</div></a>`).join('')}</div>`
    : '';
  return headOpen({ title, description, canonical: url, extraLd: articleLd + '\n' + faqLd + '\n' + crumbLd }) + '\n' + NAV + `

<article><div class="wrap">
  <div class="crumb"><a href="/">Home</a> · <a href="/denial-codes/">Denial Code Library</a> · ${esc(c.code)}</div>
  <span class="tag">${esc(c.category_label)}</span>
  <h1>${esc(c.code)}: ${esc(c.title)}</h1>
  <p class="byline">Group ${esc(c.group)} — ${esc(c.group_label)} · Denial Code Library · Updated ${UPDATED_HUMAN}</p>

  <div class="prose">
    <h2>What ${esc(c.code)} means</h2>
    <p>${esc(c.meaning)}</p>

    <h2>What it usually means on a real remittance</h2>
    <p>${esc(c.on_remittance)}</p>

    <h2>Common causes</h2>
    <ul>
${c.causes.map((x) => `      <li>${esc(x)}</li>`).join('\n')}
    </ul>

    <h2>How to fix or appeal ${esc(c.code)}</h2>
    <ol>
${c.fix_steps.map((x) => `      <li>${esc(x)}</li>`).join('\n')}
    </ol>

    <div class="route"><strong>Corrected claim or appeal?</strong> ${esc(c.route)}</div>

    <h2>The deadline angle</h2>
    <p>Every remedy above runs against a clock. Corrected claims and appeals have to land inside the payer's filing and appeal windows, and those windows are counted from the date of service — see the standard <a href="/deadlines/">timely filing limits by payer</a> and verify against your contract. If this denial is sitting in a pile of aging claims, run the <a href="/audit/">free deadline audit</a> to see which of them expire first.</p>

    <h2>${esc(c.code)} — frequently asked questions</h2>
${c.faq.map((f) => `    <h3>${esc(f.q)}</h3>\n    <p>${esc(f.a)}</p>`).join('\n')}

    ${relatedHtml}
    ${ctaBand()}
  </div>
</div></article>

` + FOOTER + '\n';
}

/* ---------------- library index ---------------- */
function indexPage() {
  const url = 'https://claimpaid.io/denial-codes/';
  const title = 'Denial Code Library — CARC Meanings, Causes & Fixes | ClaimPaid';
  const description = 'Plain-language meanings for the claim adjustment reason codes (CARCs) that drive medical claim denials — what each code means on a remittance, why it happens, and how to fix or appeal it.';
  const crumbLd = ld({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://claimpaid.io/' },
      { '@type': 'ListItem', position: 2, name: 'Denial Code Library', item: url },
    ],
  });
  const chips = ['all', ...CATEGORY_ORDER.filter((cat) => CODES.some((c) => c.category === cat))]
    .map((cat, i) => `<button type="button" class="chip" data-filter="${cat}" aria-pressed="${i === 0 ? 'true' : 'false'}">${cat === 'all' ? 'All codes' : esc(CATEGORY_LABELS[cat])}</button>`).join('');
  const blocks = CATEGORY_ORDER.filter((cat) => CODES.some((c) => c.category === cat)).map((cat) => {
    const inCat = CODES.filter((c) => c.category === cat);
    return `<section class="cat-block" data-cat-block="${cat}">
    <h2>${esc(CATEGORY_LABELS[cat])}</h2>
    <p class="cat-sub">${inCat.length} code${inCat.length === 1 ? '' : 's'}</p>
    <div class="code-grid">${inCat.map((c) => `<a class="code-card" href="/denial-codes/${c.slug}/" data-code="${esc(c.code.toLowerCase())}" data-title="${esc(c.title.toLowerCase())}" data-cat="${c.category}"><div class="cc">${esc(c.code)}</div><div class="ct">${esc(c.title)}</div><div class="cm">${esc(c.meaning.split('. ')[0])}.</div></a>`).join('')}</div>
  </section>`;
  }).join('\n  ');
  return headOpen({ title, description, canonical: url, extraLd: crumbLd }) + '\n' + NAV + `

<article><div class="wrap-wide">
  <div class="crumb"><a href="/">Home</a> · Denial Code Library</div>
  <span class="tag">Reference</span>
  <h1>The Denial Code Library</h1>
  <p class="byline">Every claim adjustment reason code (CARC), in plain language — what it means, why it happens, and how billing teams fix it.</p>

  <div class="prose">
    <p>A denial arrives as a code, not an explanation. This library translates the highest-volume CARCs — the CO, PR, and OA codes that make up most remittance denials — into what they mean on a real 835, the causes that produce them in real practices, and the fix that actually works: corrected claim, appeal, reroute, or write-off. No code is worth fighting the same way, and fighting the wrong way burns the one resource denials don't refund — time inside the filing window.</p>
  </div>

  <div class="lib-tools">
    <input class="lib-search" id="libSearch" type="search" placeholder="Search by code or keyword — try CO-29, duplicate, deductible…" aria-label="Search denial codes"/>
    ${chips}
  </div>
  <p class="no-results" id="libNoResults">No codes match that search. Try a code (CO-16), a group (PR), or a plain word (duplicate, authorization, deductible).</p>

  ${blocks}

  <div class="wrap" style="padding:0">
    ${ctaBand()}
  </div>
</div></article>

<script>
(function () {
  var search = document.getElementById('libSearch');
  var chips = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var cards = Array.prototype.slice.call(document.querySelectorAll('.code-card'));
  var blocks = Array.prototype.slice.call(document.querySelectorAll('[data-cat-block]'));
  var empty = document.getElementById('libNoResults');
  var activeFilter = 'all';
  function apply() {
    var q = (search.value || '').trim().toLowerCase();
    var visible = 0;
    cards.forEach(function (card) {
      var okFilter = activeFilter === 'all' || card.getAttribute('data-cat') === activeFilter;
      var okSearch = !q || card.getAttribute('data-code').indexOf(q) !== -1 || card.getAttribute('data-title').indexOf(q) !== -1;
      var show = okFilter && okSearch;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    blocks.forEach(function (b) {
      var any = Array.prototype.some.call(b.querySelectorAll('.code-card'), function (c) { return c.style.display !== 'none'; });
      b.style.display = any ? '' : 'none';
    });
    empty.style.display = visible ? 'none' : 'block';
  }
  search.addEventListener('input', apply);
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      activeFilter = chip.getAttribute('data-filter');
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      apply();
    });
  });
})();
</script>
` + FOOTER + '\n';
}

/* ---------------- deadlines hub ---------------- */
function deadlinesPage() {
  const url = 'https://claimpaid.io/deadlines/';
  const title = 'Timely Filing Deadlines by Payer — Standard Limits | ClaimPaid';
  const description = 'Standard published timely filing limits for Aetna, Cigna, UnitedHealthcare, Anthem, Medicare, NY Medicaid, Humana and more — how each deadline is counted, and how to check your own claims before they expire.';
  const crumbLd = ld({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://claimpaid.io/' },
      { '@type': 'ListItem', position: 2, name: 'Timely Filing Deadlines', item: url },
    ],
  });
  const faqLd = ld({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'How is a timely filing deadline calculated?', acceptedAnswer: { '@type': 'Answer', text: 'Deadline = date of service + the payer\'s timely filing limit in days. The claim must be received (and accepted) by the payer by that date. Rejected claims do not count as filed, so a rejection near the deadline leaves almost no room to correct and resubmit.' } },
      { '@type': 'Question', name: 'Which payer has the shortest timely filing limit?', acceptedAnswer: { '@type': 'Answer', text: 'Among the national payers listed here, UnitedHealthcare and NY Medicaid use 90 days from the date of service — the shortest standard windows. Aetna allows 120 days; Cigna, Anthem and Humana 180; Medicare 365.' } },
      { '@type': 'Question', name: 'Do these limits apply to corrected claims and appeals?', acceptedAnswer: { '@type': 'Answer', text: 'Corrected claims and appeals have their own windows, which vary by payer and contract and often run from the remittance date rather than the date of service. The standard limits on this page are initial filing limits — verify appeal and corrected-claim windows in your payer contract.' } },
    ],
  });
  const rows = deadlinesData.payers.map((p) => `        <tr><td><strong>${esc(p.name)}</strong></td><td><strong>${p.days} days</strong></td><td>${esc(p.note)}</td></tr>`).join('\n');
  return headOpen({ title, description, canonical: url, extraLd: faqLd + '\n' + crumbLd }) + '\n' + NAV + `

<article><div class="wrap">
  <div class="crumb"><a href="/">Home</a> · Timely Filing Deadlines</div>
  <span class="tag">Reference</span>
  <h1>Timely filing deadlines by payer</h1>
  <p class="byline">Standard published limits · Updated ${UPDATED_HUMAN} · Your payer contract controls — verify before acting</p>

  <div class="prose">
    <p>Every payer gives you a fixed number of days from the date of service to get a claim filed. Miss it and the claim denies as <a href="/denial-codes/co-29/">CO-29 — time limit for filing expired</a> — the one denial that is almost never overturned without proof the claim was submitted on time. These are the standard published limits ClaimPaid's deadline tracking uses; individual contracts, plan products, and state rules can shorten or lengthen them.</p>

    <table>
      <thead><tr><th>Payer</th><th>Standard limit</th><th>Notes</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>

    <h2>How the deadline is computed</h2>
    <p><strong>Deadline = date of service + the payer's limit in days.</strong> The claim has to be <em>received and accepted</em> by the payer by that date. Three consequences follow:</p>
    <ul>
      <li><strong>Rejected is not filed.</strong> A claim rejected by the clearinghouse or the payer's front-end edits never starts the clock-stopping process — it is an unfiled claim with the deadline still approaching.</li>
      <li><strong>Wrong payer, same clock.</strong> Billing the wrong plan first (see <a href="/denial-codes/co-109/">CO-109</a>) does not pause the correct payer's window.</li>
      <li><strong>Appeals have their own windows.</strong> Appeal and corrected-claim deadlines are usually counted from the remittance date and set by your contract — they are separate from, and often shorter than, the initial filing limit.</li>
    </ul>

    <div class="note"><strong>The disclaimer that matters:</strong> ${esc(deadlinesData.meta.disclaimer)}</div>

    <h2>Check your own claims against these deadlines</h2>
    <p>The free <a href="/audit/">deadline audit tool</a> applies exactly these limits to your open claims — paste them in or drop a CSV, and it ranks every claim by days left, entirely in your browser. For the deeper guide to how each payer's rules work in practice, read <a href="/blog/timely-filing-limits-by-payer-2026/">Timely Filing Limits by Payer 2026</a> on the ClaimPaid blog.</p>

    ${ctaBand()}
  </div>
</div></article>

` + FOOTER + '\n';
}

/* ---------------- write everything ---------------- */
function write(rel, content) {
  const p = path.join(OUT_DIR, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return rel;
}
const written = [];
written.push(write('denial-codes/index.html', indexPage()));
for (const c of CODES) written.push(write(`denial-codes/${c.slug}/index.html`, codePage(c)));
written.push(write('deadlines/index.html', deadlinesPage()));
console.log(`Generated ${written.length} pages (${CODES.length} codes + index + deadlines) into ${OUT_DIR}`);
