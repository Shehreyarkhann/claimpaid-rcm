/* ClaimPaid — public deadline audit tool (/audit/).
 *
 * 100% client-side: the CSV is parsed and every deadline is computed in
 * this browser. No claim data is ever sent anywhere. The only network
 * call this page can make is the OPTIONAL lead form, which posts
 * aggregate summary numbers (counts and totals) — never claim rows.
 *
 * Logic is exposed as window.CPAudit so it can be tested headlessly.
 */
(function () {
  'use strict';

  /* Timely-filing rules — the same standard published limits the
   * ClaimPaid product tracks (see landing-data/payer-deadlines.json).
   * The signed payer contract controls; verify before acting. */
  var RULES = [
    { name: 'Aetna', days: 120 },
    { name: 'Cigna', days: 180 },
    { name: 'UnitedHealthcare', days: 90 },
    { name: 'Anthem', days: 180 },
    { name: 'Medicare', days: 365 },
    { name: 'NY Medicaid', days: 90 },
    { name: 'Humana', days: 180 },
    { name: 'Other payer', days: 365 }
  ];

  function ruleFor(payerName) {
    var p = String(payerName || '').trim().toLowerCase();
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].name.toLowerCase() === p) return RULES[i];
    }
    if (/uhc|united/.test(p)) return RULES[2];
    if (/medicaid/.test(p) && /ny|new york/.test(p)) return RULES[5];
    if (/medicare/.test(p)) return RULES[4];
    if (/aetna/.test(p)) return RULES[0];
    if (/cigna/.test(p)) return RULES[1];
    if (/anthem|bcbs|blue/.test(p)) return RULES[3];
    if (/humana/.test(p)) return RULES[6];
    return RULES[RULES.length - 1];
  }

  /* ---- dates: all math on UTC midnights so DST never shifts a day ---- */
  function parseDate(v) {
    if (!v) return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
    return null;
  }
  function isoOf(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
  function todayMs() {
    var n = new Date();
    return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  }
  var DAY = 86400000;

  function bucketFor(daysLeft) {
    if (daysLeft < 0) return 'expired';
    if (daysLeft <= 14) return 'd14';
    if (daysLeft <= 30) return 'd30';
    if (daysLeft <= 60) return 'd60';
    return 'safe';
  }
  var BUCKETS = [
    { key: 'expired', label: 'Expired — past the filing deadline' },
    { key: 'd14', label: 'Due within 14 days' },
    { key: 'd30', label: 'Due within 30 days' },
    { key: 'd60', label: 'Due within 60 days' },
    { key: 'safe', label: 'Safe — more than 60 days left' }
  ];

  function parseMoney(v) {
    if (v === null || v === undefined) return 0;
    var n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /* rows: [{ref, payer, amount, dos}] with dos as a date string.
   * today: optional ISO date string for deterministic tests. */
  function computeAudit(rows, today) {
    var now = today ? parseDate(today) : todayMs();
    var claims = [];
    (rows || []).forEach(function (r, i) {
      var dosMs = parseDate(r.dos);
      if (dosMs === null) return;
      var rule = ruleFor(r.payer);
      var deadlineMs = dosMs + rule.days * DAY;
      var daysLeft = Math.round((deadlineMs - now) / DAY);
      claims.push({
        ref: r.ref ? String(r.ref) : 'Row ' + (i + 1),
        payer: rule.name === 'Other payer' && r.payer ? String(r.payer) : rule.name,
        amount: parseMoney(r.amount),
        dos: isoOf(dosMs),
        deadline: isoOf(deadlineMs),
        daysLeft: daysLeft,
        bucket: bucketFor(daysLeft)
      });
    });
    claims.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
    var buckets = {};
    BUCKETS.forEach(function (b) { buckets[b.key] = { count: 0, dollars: 0 }; });
    var atRiskDollars = 0, nearest = null;
    claims.forEach(function (c) {
      buckets[c.bucket].count++;
      buckets[c.bucket].dollars += c.amount;
      if (c.bucket !== 'safe') atRiskDollars += c.amount;
      if (nearest === null || c.daysLeft < nearest) nearest = c.daysLeft;
    });
    return {
      claims: claims,
      buckets: buckets,
      totals: {
        claims: claims.length,
        atRiskDollars: atRiskDollars,
        atRiskCount: claims.length - buckets.safe.count,
        expiredDollars: buckets.expired.dollars,
        expiredCount: buckets.expired.count,
        nearestDeadlineDays: nearest
      }
    };
  }

  /* ---- CSV parsing (hand-rolled, RFC-4180-style) ---- */
  function parseCSV(text) {
    var rows = [], row = [], field = '', inQ = false;
    var s = String(text || '').replace(/^\uFEFF/, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }

  function detectColumns(header) {
    var norm = header.map(function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); });
    function find() {
      for (var i = 0; i < norm.length; i++) {
        for (var j = 0; j < arguments.length; j++) {
          if (norm[i].indexOf(arguments[j]) !== -1) return i;
        }
      }
      return -1;
    }
    var dos = find('dateofservice', 'servicedate', 'dos', 'svcdate');
    if (dos === -1) dos = find('date');
    return {
      payer: find('payer', 'insurer', 'insurance', 'carrier', 'plan'),
      amount: find('billedamount', 'amount', 'billed', 'charge', 'balance', 'total'),
      dos: dos,
      ref: find('claimnumber', 'claimref', 'claimid', 'claim', 'reference', 'ref')
    };
  }

  function rowsFromCSV(text) {
    var grid = parseCSV(text);
    if (!grid.length) return { rows: [], error: 'That file looks empty.' };
    var cols = detectColumns(grid[0]);
    var start = 1;
    if (cols.dos === -1 || (cols.payer === -1 && cols.amount === -1)) {
      // No usable header — treat every row as [ref?, payer, dos, amount] fallback is too
      // fragile; ask for headers instead.
      return { rows: [], error: 'We could not find the columns. Your CSV needs a header row with payer, date of service, and amount columns (names like "Payer", "Date of Service", "Billed Amount" all work).' };
    }
    var rows = [];
    for (var i = start; i < grid.length; i++) {
      var g = grid[i];
      if (!g || g.every(function (c) { return String(c).trim() === ''; })) continue;
      rows.push({
        ref: cols.ref >= 0 ? g[cols.ref] : '',
        payer: cols.payer >= 0 ? g[cols.payer] : '',
        dos: g[cols.dos],
        amount: cols.amount >= 0 ? g[cols.amount] : 0
      });
    }
    return { rows: rows, error: null };
  }

  var api = {
    RULES: RULES, BUCKETS: BUCKETS,
    ruleFor: ruleFor, parseDate: parseDate, bucketFor: bucketFor,
    computeAudit: computeAudit, parseCSV: parseCSV,
    detectColumns: detectColumns, rowsFromCSV: rowsFromCSV
  };
  if (typeof window !== 'undefined') window.CPAudit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  /* ================= DOM wiring (browser only) ================= */
  if (typeof document === 'undefined') return;

  function $(id) { return document.getElementById(id); }
  function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  var lastReport = null;

  function manualRows() {
    var rows = [];
    document.querySelectorAll('#manualBody tr').forEach(function (tr) {
      var dos = tr.querySelector('.m-dos').value;
      var amount = tr.querySelector('.m-amt').value;
      var payer = tr.querySelector('.m-payer').value;
      var ref = tr.querySelector('.m-ref').value;
      if (!dos && !amount) return;
      rows.push({ ref: ref, payer: payer, dos: dos, amount: amount });
    });
    return rows;
  }

  function render(report) {
    lastReport = report;
    var t = report.totals;
    $('rRisk').textContent = money(t.atRiskDollars);
    $('rRiskCount').textContent = t.atRiskCount + ' of ' + t.claims + ' claims expired or due within 60 days';
    $('rExpired').textContent = money(t.expiredDollars);
    $('rExpiredCount').textContent = t.expiredCount + ' claim' + (t.expiredCount === 1 ? '' : 's') + ' already past the deadline';
    $('rNearest').textContent = t.nearestDeadlineDays === null ? '—' : (t.nearestDeadlineDays < 0 ? Math.abs(t.nearestDeadlineDays) + 'd overdue' : t.nearestDeadlineDays + 'd left');
    var bt = $('bucketBody');
    bt.innerHTML = '';
    BUCKETS.forEach(function (b) {
      var v = report.buckets[b.key];
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><strong></strong></td><td></td><td></td>';
      tr.children[0].firstChild.textContent = b.label;
      tr.children[1].textContent = v.count;
      tr.children[2].textContent = money(v.dollars);
      bt.appendChild(tr);
    });
    var ct = $('claimBody');
    ct.innerHTML = '';
    report.claims.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.className = 'bucket-' + c.bucket;
      var when = c.daysLeft < 0 ? Math.abs(c.daysLeft) + ' days overdue' : c.daysLeft + ' days left';
      [c.ref, c.payer, c.dos, c.deadline, when, money(c.amount)].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      ct.appendChild(tr);
    });
    $('report').style.display = '';
    $('leadForm').querySelector('button[type="submit"]').disabled = false;
    $('leadHint').textContent = 'We will email the timely-filing checklist to you. Only these summary totals are sent — never your claim rows.';
    $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function run(rows) {
    var note = $('auditError');
    if (!rows.length) {
      note.textContent = 'Add at least one claim with a date of service — by hand below, or by dropping a CSV.';
      note.style.display = '';
      return;
    }
    note.style.display = 'none';
    render(computeAudit(rows));
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Manual rows
    var body = $('manualBody');
    var payerOptions = RULES.map(function (r) { return '<option>' + r.name + '</option>'; }).join('');
    for (var i = 0; i < 10; i++) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><input class="m-ref" type="text" placeholder="CLM-1001" aria-label="Claim reference"/></td>' +
        '<td><select class="m-payer" aria-label="Payer">' + payerOptions + '</select></td>' +
        '<td><input class="m-dos" type="date" aria-label="Date of service"/></td>' +
        '<td><input class="m-amt" type="number" min="0" step="0.01" placeholder="0.00" aria-label="Billed amount"/></td>';
      body.appendChild(tr);
    }
    $('runManual').addEventListener('click', function () { run(manualRows()); });

    // CSV: file drop / picker / paste
    var fileInput = $('csvFile');
    function handleText(text) {
      var parsed = rowsFromCSV(text);
      var note = $('auditError');
      if (parsed.error) { note.textContent = parsed.error; note.style.display = ''; return; }
      run(parsed.rows);
    }
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { handleText(String(reader.result || '')); };
      reader.readAsText(f);
    });
    var drop = $('dropZone');
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { handleText(String(reader.result || '')); };
      reader.readAsText(f);
    });
    $('csvPaste').addEventListener('change', function () {
      if ($('csvPaste').value.trim()) handleText($('csvPaste').value);
    });

    $('printBtn').addEventListener('click', function () { window.print(); });

    var shareBtn = $('shareBtn');
    shareBtn.addEventListener('click', function () {
      var url = 'https://claimpaid.io/audit/';
      function done() { shareBtn.textContent = 'Link copied — share it with your team'; setTimeout(function () { shareBtn.textContent = 'Copy link to this tool'; }, 3000); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
      else done();
    });

    // Lead form — aggregates only, by construction.
    $('leadForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!lastReport) return;
      var t = lastReport.totals;
      var payload = {
        name: $('leadName').value,
        email: $('leadEmail').value,
        company: $('leadCompany').value,
        website: $('leadWebsite').value,
        claims_count: t.claims,
        dollars_at_risk: Math.round(t.atRiskDollars),
        nearest_deadline_days: t.nearestDeadlineDays,
        expired_count: t.expiredCount,
        expired_dollars: Math.round(t.expiredDollars)
      };
      var status = $('leadStatus');
      fetch('/api/leads/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) {
            status.textContent = 'Done — your timely-filing checklist is on its way to ' + payload.email + '.';
            status.className = 'lead-status ok';
            $('leadForm').querySelector('button[type="submit"]').disabled = true;
          } else {
            status.textContent = (res.j && res.j.error) || 'Something went wrong — please try again.';
            status.className = 'lead-status err';
          }
        })
        .catch(function () {
          status.textContent = 'Something went wrong — please try again.';
          status.className = 'lead-status err';
        });
    });
  });
})();
