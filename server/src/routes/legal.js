const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const { authRequired, roleRequired } = require('../auth');

const router = express.Router();

const LEGAL_DIR = path.join(__dirname, '..', '..', 'legal');
const DOCS = {
  terms: { file: 'terms-v1-draft.md', version: 'v1-draft' },
  privacy: { file: 'privacy-v1-draft.md', version: 'v1-draft' },
  baa: { file: 'baa-v1-draft.md', version: 'v1-draft' },
};

// In-memory cache; files are versioned, so no invalidation needed per version
const textCache = {};

function docText(key) {
  const cfg = DOCS[key];
  if (!cfg) return null;
  if (!textCache[key]) {
    textCache[key] = fs.readFileSync(path.join(LEGAL_DIR, cfg.file), 'utf8');
  }
  return textCache[key];
}

function baaTextHash() {
  return crypto.createHash('sha256').update(docText('baa'), 'utf8').digest('hex');
}

function baaVersion() {
  return DOCS.baa.version;
}

// ---- GET /api/legal/documents (public) ----
router.get('/documents', (req, res) => {
  try {
    res.json({
      terms: { version: DOCS.terms.version, text: docText('terms') },
      privacy: { version: DOCS.privacy.version, text: docText('privacy') },
      baa: { version: DOCS.baa.version, text: docText('baa') },
    });
  } catch (e) {
    console.error('Legal documents read failed:', e.message);
    res.status(500).json({ error: 'Legal documents unavailable' });
  }
});

// ---- GET /api/legal/baa/status (auth) ----
router.get('/baa/status', authRequired, (req, res) => {
  const sig = db.prepare('SELECT * FROM baa_signatures WHERE org_id = ?').get(req.orgId);
  if (!sig) return res.json({ signed: false, signature: null });
  res.json({
    signed: true,
    current: sig.baa_version === baaVersion(),
    signature: {
      org_legal_name: sig.org_legal_name,
      signed_by_name: sig.signed_by_name,
      signed_by_title: sig.signed_by_title,
      signed_by_email: sig.signed_by_email,
      signed_at: sig.signed_at,
      ip_address: sig.ip_address,
      baa_version: sig.baa_version,
      text_hash: sig.text_hash,
      created_at: sig.created_at,
    },
  });
});

// ---- POST /api/legal/baa/sign (auth + owner) ----
router.post('/baa/sign', authRequired, roleRequired('owner'), (req, res) => {
  const { org_legal_name, signed_by_name, signed_by_title, agree } = req.body || {};

  if (!org_legal_name || !String(org_legal_name).trim()) {
    return res.status(400).json({ error: 'Organization legal name is required' });
  }
  if (!signed_by_name || !String(signed_by_name).trim()) {
    return res.status(400).json({ error: 'Signer name is required' });
  }
  if (agree !== true) {
    return res.status(400).json({ error: 'You must agree to the BAA to sign it' });
  }

  const version = baaVersion();
  const existing = db.prepare('SELECT * FROM baa_signatures WHERE org_id = ?').get(req.orgId);
  if (existing && existing.baa_version === version) {
    return res.status(409).json({ error: 'BAA already signed for this workspace', signature: {
      signed_at: existing.signed_at, baa_version: existing.baa_version,
    }});
  }

  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  const now = new Date().toISOString();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || null;

  const row = {
    org_id: req.orgId,
    org_legal_name: String(org_legal_name).trim().slice(0, 200),
    signed_by_name: String(signed_by_name).trim().slice(0, 120),
    signed_by_title: signed_by_title ? String(signed_by_title).trim().slice(0, 120) : null,
    signed_by_email: user?.email || req.user.email,
    signed_at: now,
    ip_address: ip,
    baa_version: version,
    text_hash: baaTextHash(),
  };

  try {
    if (existing) {
      // Re-sign on a new BAA version: replace the old signature row
      db.prepare(`UPDATE baa_signatures SET org_legal_name = ?, signed_by_name = ?,
        signed_by_title = ?, signed_by_email = ?, signed_at = ?, ip_address = ?,
        baa_version = ?, text_hash = ? WHERE org_id = ?`)
        .run(row.org_legal_name, row.signed_by_name, row.signed_by_title,
             row.signed_by_email, row.signed_at, row.ip_address,
             row.baa_version, row.text_hash, req.orgId);
    } else {
      db.prepare(`INSERT INTO baa_signatures
        (org_id, org_legal_name, signed_by_name, signed_by_title, signed_by_email,
         signed_at, ip_address, baa_version, text_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.org_id, row.org_legal_name, row.signed_by_name, row.signed_by_title,
             row.signed_by_email, row.signed_at, row.ip_address,
             row.baa_version, row.text_hash);
    }
  } catch (e) {
    console.error('BAA sign failed:', e.message);
    return res.status(500).json({ error: 'Could not record signature' });
  }

  res.json({
    signed: true,
    signature: {
      org_legal_name: row.org_legal_name,
      signed_by_name: row.signed_by_name,
      signed_by_title: row.signed_by_title,
      signed_by_email: row.signed_by_email,
      signed_at: row.signed_at,
      baa_version: row.baa_version,
      text_hash: row.text_hash,
    },
  });
});

// Helpers for other routes (billing gate, super-admin)
function baaSignedForOrg(orgId) {
  const sig = db.prepare('SELECT id FROM baa_signatures WHERE org_id = ?').get(orgId);
  return !!sig;
}

function baaSignatureForOrg(orgId) {
  return db.prepare('SELECT * FROM baa_signatures WHERE org_id = ?').get(orgId) || null;
}

module.exports = { legalRoutes: router, baaSignedForOrg, baaSignatureForOrg, baaVersion, baaTextHash };
