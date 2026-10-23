// Pluggable claim-transmission adapters (mirrors the eligibility vendor pattern).
//
// Honest architecture: real electronic submission needs a clearinghouse account
// (Change Healthcare, Availity, Waystar, Office Ally) PLUS per-payer enrollment.
// Until the org configures one, the `manual` adapter is the default: the app
// generates a valid 837P file, the user uploads it to their clearinghouse
// portal themselves, and explicitly confirms. The app NEVER claims a file was
// transmitted when it wasn't — manual transmission requires confirmed: true.
//
// Adapters:
//   manual — no network; route requires explicit user confirmation.
//   sftp   — drops the 837P into the clearinghouse's SFTP inbox (ssh2).
//   rest   — POSTs the file to a configured HTTPS endpoint (JSON wrapper).
//
// transmit(adapterName, orgConfig, { ediText, batchNumber }) resolves to
// { adapter, detail } on success and THROWS on any failure. The batch keeps
// status 'generated' unless transmit succeeds.

const XMIT_VENDORS = ['manual', 'sftp', 'rest'];

function orgXmitConfig(orgId) {
  const { db } = require('../db');
  const o = db.prepare(
    `SELECT xmit_vendor, xmit_sftp_host, xmit_sftp_port, xmit_sftp_user,
            xmit_sftp_auth, xmit_sftp_secret, xmit_sftp_dir,
            xmit_rest_endpoint, xmit_rest_api_key, xmit_rest_auth_scheme
     FROM orgs WHERE id = ?`
  ).get(orgId) || {};
  const vendor = XMIT_VENDORS.includes(o.xmit_vendor) ? o.xmit_vendor : 'manual';
  return {
    vendor,
    sftp: {
      host: (o.xmit_sftp_host || '').trim(),
      port: Number(o.xmit_sftp_port) || 22,
      user: (o.xmit_sftp_user || '').trim(),
      auth: o.xmit_sftp_auth === 'key' ? 'key' : 'password',
      secret: o.xmit_sftp_secret || '',
      dir: (o.xmit_sftp_dir || '/').trim() || '/',
    },
    rest: {
      endpoint: (o.xmit_rest_endpoint || '').trim(),
      api_key: o.xmit_rest_api_key || '',
      auth_scheme: (o.xmit_rest_auth_scheme || 'Bearer').trim() || 'Bearer',
    },
  };
}

// ---- sftp adapter -----------------------------------------------------------

const SFTP_TIMEOUT_MS = 25000;

function sftpTransmit(sftpCfg, ediText, batchNumber) {
  let ssh2;
  try {
    ssh2 = require('ssh2');
  } catch {
    throw new Error('SFTP support is not installed on this server (ssh2 module missing).');
  }
  if (!sftpCfg.host) throw new Error('No SFTP host configured — set it in Transmission settings.');
  if (!sftpCfg.user) throw new Error('No SFTP username configured — set it in Transmission settings.');
  if (!sftpCfg.secret) throw new Error('No SFTP credential configured — set a password or private key in Transmission settings.');

  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client();
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* already closed */ }
      fn(val);
    };
    const timer = setTimeout(() => done(reject, new Error(`SFTP connection to ${sftpCfg.host} timed out`)), SFTP_TIMEOUT_MS);

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return done(reject, new Error('SFTP subsystem failed: ' + err.message));
        const dir = sftpCfg.dir.replace(/\/?$/, '/');
        const remotePath = `${dir}claimpaid-837P-${batchNumber}.txt`;
        const ws = sftp.createWriteStream(remotePath);
        ws.on('error', (e) => done(reject, new Error('SFTP upload failed: ' + e.message)));
        ws.on('close', () => done(resolve, { remotePath, host: sftpCfg.host }));
        ws.end(ediText);
      });
    });
    conn.on('error', (e) => done(reject, new Error('SFTP connection failed: ' + e.message)));

    const connectOpts = {
      host: sftpCfg.host,
      port: sftpCfg.port,
      username: sftpCfg.user,
      readyTimeout: SFTP_TIMEOUT_MS,
    };
    if (sftpCfg.auth === 'key') connectOpts.privateKey = sftpCfg.secret;
    else connectOpts.password = sftpCfg.secret;
    try {
      conn.connect(connectOpts);
    } catch (e) {
      done(reject, new Error('SFTP connection failed: ' + e.message));
    }
  });
}

// ---- rest adapter -----------------------------------------------------------

const REST_TIMEOUT_MS = 30000;

async function restTransmit(restCfg, ediText, batchNumber, controlNumber) {
  const endpoint = restCfg.endpoint;
  if (!endpoint) throw new Error('No transmission endpoint configured — set one in Transmission settings.');
  if (!/^https?:\/\//i.test(endpoint)) throw new Error('Transmission endpoint must be an http(s) URL.');

  const headers = { 'Content-Type': 'application/json' };
  const scheme = restCfg.auth_scheme;
  if (restCfg.api_key) {
    if (/^basic$/i.test(scheme)) headers.Authorization = 'Basic ' + Buffer.from(restCfg.api_key).toString('base64');
    else if (/^bearer$/i.test(scheme)) headers.Authorization = 'Bearer ' + restCfg.api_key;
    else headers[scheme] = restCfg.api_key;
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        batch_number: batchNumber,
        control_number: controlNumber,
        format: 'X12-837P-005010X222A1',
        edi_text: ediText,
      }),
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Transmission endpoint unreachable: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Transmission endpoint returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { endpoint, httpStatus: res.status, response: text.slice(0, 500) };
}

// ---- entry point ------------------------------------------------------------

async function transmit(vendorName, orgConfig, payload) {
  const { ediText, batchNumber, controlNumber } = payload;
  if (!ediText) throw new Error('No 837P file generated for this batch yet.');
  if (vendorName === 'manual') {
    // Manual is a user-confirmed handoff, not a network call — the route
    // enforces confirmed:true before marking transmitted.
    return { adapter: 'manual', detail: 'User-confirmed manual upload to clearinghouse portal' };
  }
  if (vendorName === 'sftp') {
    const detail = await sftpTransmit(orgConfig.sftp, ediText, batchNumber);
    return { adapter: 'sftp', detail };
  }
  if (vendorName === 'rest') {
    const detail = await restTransmit(orgConfig.rest, ediText, batchNumber, controlNumber);
    return { adapter: 'rest', detail };
  }
  throw new Error(`Unknown transmission vendor: ${vendorName}`);
}

module.exports = { transmit, orgXmitConfig, XMIT_VENDORS };
