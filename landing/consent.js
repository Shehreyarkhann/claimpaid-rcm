/* ClaimPaid cookie consent — landing surfaces only (deploy #102).
 *
 * Vanilla, dependency-free. Responsibilities:
 *  - Store the visitor's consent record in the first-party `cp_consent`
 *    cookie (version + choices + timestamp, 12-month expiry).
 *  - Show the consent banner when there is no valid stored record for
 *    the current policy version (Accept all / Reject non-essential /
 *    Customize, equal weight, no dark patterns).
 *  - Gate the Cloudflare Web Analytics beacon: it is injected ONLY when
 *    analytics consent is granted. Pages no longer carry the beacon
 *    snippet inline (deploy #96's unconditional snippet was removed).
 *  - Reopen the preferences modal any time via [data-cp-consent-open]
 *    elements (footer "Cookie settings" link) or window.ClaimPaidConsent.open().
 *
 * Categories not in use today (marketing, functional) are recorded as
 * false and shown disabled in the modal: there is nothing to consent to
 * yet. When a future tool needs one of them, bump POLICY_VERSION — the
 * stored record stops matching and every visitor is asked again.
 */
(function () {
  'use strict';

  var POLICY_VERSION = 1;
  var COOKIE_NAME = 'cp_consent';
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 12 months, in seconds
  var BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
  var BEACON_TOKEN = 'ff492d06eea9413ead0a4480407c7846';
  var POLICY_URL = '/cookies/';

  /* ---------------- consent record ---------------- */

  function readConsent() {
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
      if (!match) return null;
      var rec = JSON.parse(decodeURIComponent(match[1]));
      if (!rec || rec.v !== POLICY_VERSION || !rec.choices) return null;
      return rec;
    } catch (e) {
      return null;
    }
  }

  function writeConsent(choices) {
    var rec = { v: POLICY_VERSION, ts: new Date().toISOString(), choices: choices };
    document.cookie =
      COOKIE_NAME + '=' + encodeURIComponent(JSON.stringify(rec)) +
      '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax';
    return rec;
  }

  function baseChoices() {
    return { necessary: true, analytics: false, marketing: false, functional: false };
  }

  /* ---------------- analytics beacon (gated) ---------------- */

  var beaconInjected = false;
  function loadBeacon() {
    if (beaconInjected) return;
    if (document.querySelector('script[src="' + BEACON_SRC + '"]')) { beaconInjected = true; return; }
    beaconInjected = true;
    var s = document.createElement('script');
    s.type = 'module';
    s.src = BEACON_SRC;
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: BEACON_TOKEN }));
    document.head.appendChild(s);
  }

  function applyChoices(choices) {
    if (choices && choices.analytics) loadBeacon();
  }

  /* ---------------- DOM helpers ---------------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------------- banner ---------------- */

  var banner = null;

  function closeBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function showBanner() {
    if (banner) return;
    banner = el('div', 'cp-consent-banner');
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');

    banner.appendChild(el('h2', null, 'A quick word on cookies'));
    var p = el('p');
    p.appendChild(document.createTextNode(
      'We use cookies that are strictly necessary for this site to work. ' +
      'With your permission, we also use privacy-friendly, cookieless analytics ' +
      'to understand which pages help billing teams most. No advertising trackers, ever. '));
    var link = el('a', null, 'Cookie policy');
    link.href = POLICY_URL;
    p.appendChild(link);
    banner.appendChild(p);

    var actions = el('div', 'cp-consent-actions');
    var accept = el('button', 'cp-consent-btn cp-consent-btn-accept', 'Accept all');
    accept.type = 'button';
    accept.addEventListener('click', function () {
      var choices = baseChoices();
      choices.analytics = true;
      saveAndClose(choices);
    });
    var reject = el('button', 'cp-consent-btn cp-consent-btn-reject', 'Reject non-essential');
    reject.type = 'button';
    reject.addEventListener('click', function () {
      saveAndClose(baseChoices());
    });
    var customize = el('button', 'cp-consent-btn cp-consent-btn-customize', 'Customize');
    customize.type = 'button';
    customize.addEventListener('click', function () { openModal(); });
    actions.appendChild(accept);
    actions.appendChild(reject);
    actions.appendChild(customize);
    banner.appendChild(actions);

    document.body.appendChild(banner);
  }

  function saveAndClose(choices) {
    writeConsent(choices);
    applyChoices(choices);
    closeBanner();
    closeModal();
  }

  /* ---------------- preferences modal ---------------- */

  var overlay = null;
  var lastFocused = null;
  var analyticsToggle = null;

  function categoryRow(opts) {
    var row = el('div', 'cp-consent-cat');
    var head = el('div', 'cp-consent-cat-head');
    head.appendChild(el('h3', null, opts.title));
    if (opts.locked) {
      head.appendChild(el('span', 'cp-consent-tag', 'Always on'));
    } else if (opts.unused) {
      head.appendChild(el('span', 'cp-consent-tag cp-consent-tag-muted', 'Not currently used'));
    } else {
      var label = el('label', 'cp-consent-switch');
      label.setAttribute('aria-label', opts.title);
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!opts.checked;
      var track = el('span', 'cp-consent-track');
      label.appendChild(input);
      label.appendChild(track);
      head.appendChild(label);
      opts.onToggle = input;
    }
    row.appendChild(head);
    row.appendChild(el('p', null, opts.text));
    return row;
  }

  function openModal() {
    if (overlay) return;
    lastFocused = document.activeElement;
    var stored = readConsent();
    var current = stored ? stored.choices : baseChoices();

    overlay = el('div', 'cp-consent-overlay');
    var modal = el('div', 'cp-consent-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'cp-consent-modal-title');

    var head = el('div', 'cp-consent-modal-head');
    var title = el('h2', null, 'Cookie preferences');
    title.id = 'cp-consent-modal-title';
    head.appendChild(title);
    var close = el('button', 'cp-consent-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close cookie preferences');
    close.addEventListener('click', function () { dismissModal(); });
    head.appendChild(close);
    modal.appendChild(head);

    var intro = el('p', 'cp-consent-intro');
    intro.appendChild(document.createTextNode(
      'Choose what ClaimPaid may use on this website. Your choices are stored for 12 months, ' +
      'and you can change them any time from the "Cookie settings" link in the footer. ' +
      'Full details are in the '));
    var pol = el('a', null, 'cookie policy');
    pol.href = POLICY_URL;
    intro.appendChild(pol);
    intro.appendChild(document.createTextNode('.'));
    modal.appendChild(intro);

    modal.appendChild(categoryRow({
      title: 'Strictly necessary',
      locked: true,
      text: 'Required for the site and the signed-in app to work — including the cookie that ' +
            'remembers the choices you make here, and the sign-in token that keeps you logged in. ' +
            'These cannot be switched off.'
    }));

    var analyticsRow = categoryRow({
      title: 'Analytics',
      checked: current.analytics,
      text: 'Cloudflare Web Analytics: a cookieless beacon that reports page views and page-load ' +
            'performance in aggregate, so we can see which pages are useful. It sets no cookies ' +
            'and does not track you across sites.'
    });
    analyticsToggle = analyticsRow.querySelector('input[type="checkbox"]');
    modal.appendChild(analyticsRow);

    modal.appendChild(categoryRow({
      title: 'Marketing',
      unused: true,
      text: 'Advertising and marketing cookies. ClaimPaid runs none today — no ad pixels, no ' +
            'cross-site trackers. If that ever changes, this category becomes a real choice ' +
            'and we will ask again before anything loads.'
    }));

    modal.appendChild(categoryRow({
      title: 'Functional / preferences',
      unused: true,
      text: 'Optional features that remember preferences beyond what is strictly necessary. ' +
            'None are in use today; the same promise applies — nothing loads here without ' +
            'a fresh choice from you.'
    }));

    var actions = el('div', 'cp-consent-modal-actions');
    var save = el('button', 'cp-consent-btn cp-consent-btn-accept', 'Save choices');
    save.type = 'button';
    save.addEventListener('click', function () {
      var choices = baseChoices();
      choices.analytics = !!(analyticsToggle && analyticsToggle.checked);
      saveAndClose(choices);
    });
    var acceptAll = el('button', 'cp-consent-btn cp-consent-btn-reject', 'Accept all');
    acceptAll.type = 'button';
    acceptAll.addEventListener('click', function () {
      var choices = baseChoices();
      choices.analytics = true;
      saveAndClose(choices);
    });
    actions.appendChild(save);
    actions.appendChild(acceptAll);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) dismissModal();
    });
    document.body.appendChild(overlay);

    document.addEventListener('keydown', onKeydown, true);
    var first = modal.querySelector('.cp-consent-close');
    if (first) first.focus();
  }

  function dismissModal() {
    closeModal();
    // If the visitor still has no stored choice, the banner stays their way back.
    if (!readConsent()) showBanner();
  }

  function closeModal() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    analyticsToggle = null;
    document.removeEventListener('keydown', onKeydown, true);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function onKeydown(e) {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissModal();
      return;
    }
    if (e.key !== 'Tab') return;
    var modal = overlay.querySelector('.cp-consent-modal');
    var focusables = modal.querySelectorAll('button, a[href], input:not([disabled])');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /* ---------------- footer "Cookie settings" links ---------------- */

  function bindSettingsLinks() {
    var links = document.querySelectorAll('[data-cp-consent-open]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (e) {
        e.preventDefault();
        openModal();
      });
    }
  }

  /* ---------------- init ---------------- */

  function init() {
    bindSettingsLinks();
    var stored = readConsent();
    if (stored) {
      applyChoices(stored.choices);
    } else {
      showBanner();
    }
  }

  window.ClaimPaidConsent = {
    open: openModal,
    get: readConsent,
    version: POLICY_VERSION
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
