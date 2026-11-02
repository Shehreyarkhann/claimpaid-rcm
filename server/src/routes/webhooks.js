// Stedi webhook inbox — POST /api/webhooks/stedi (mounted with a RAW body
// in index.js, before express.json, exactly like the Stripe webhook).
//
// Stedi delivers `transaction.processed` events when payer responses
// (277CA acknowledgments, 835 ERAs) are ready. v1 posture:
//   - EVERY delivery is recorded in stedi_events before anything else runs,
//     so nothing Stedi sends is ever silently dropped.
//   - If STEDI_WEBHOOK_SECRET is set, an HMAC-SHA256 signature mismatch
//     blocks PROCESSING (the event is still recorded, flagged) — never the
//     recording itself. Responses stay 200 so Stedi does not retry-storm
//     for 48h over a signature-scheme mismatch.
//   - When the payload carries an inline X12 277CA, it is matched to its
//     batch through the claims' last_batch_id (CLM01 = claim id -> TRN02)
//     and fed through the same applyAck pipeline as an uploaded ack file.
//   - Events whose payload only references a transaction (no inline X12)
//     stay recorded as unprocessed with a note; the ack can still be
//     uploaded manually on the Transmission page, as before.

const crypto = require('crypto');
const { db } = require('../db');
const { parseAck } = require('../edi/parseAck');
// applyAck lives in the transmission route module; requiring it here is
// safe (routes/transmission does not require this module).
const { applyAckToBatch } = require('./transmission');

function signatureOk(req, rawBody) {
  const secret = (process.env.STEDI_WEBHOOK_SECRET || '').trim();
  if (!secret) return { checked: false, ok: true };
  const header = req.get('webhook-signature') || req.get('svix-signature') || '';
  if (!header) return { checked: true, ok: false };
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidates = header.split(/[,\s]+/).map((s) => s.replace(/^v1,/, '').trim()).filter(Boolean);
  const ok = candidates.some((c) => {
    try {
      const a = Buffer.from(c, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  });
  return { checked: true, ok };
}

function handleStediWebhook(req, res) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  let payload = null;
  try { payload = JSON.parse(rawBody.toString('utf-8') || '{}'); } catch { payload = null; }

  const sig = signatureOk(req, rawBody);
  const eventType = payload?.type || payload?.eventType || payload?.data?.type || null;
  const transactionId =
    payload?.transactionId || payload?.data?.transactionId || payload?.transaction?.id ||
    payload?.data?.transaction?.id || null;

  let orgId = null;
  let batchId = null;
  let processed = 0;
  let note = null;

  if (!payload) {
    note = 'unparseable JSON body';
  } else if (!sig.ok) {
    note = 'signature mismatch — recorded, not processed';
  } else {
    // Best-effort inline X12: some event shapes embed the transaction
    // payload; when present and it parses as a 277CA, apply it.
    const x12 = payload.x12 || payload.data?.x12 || payload.payload?.x12 || null;
    if (typeof x12 === 'string' && x12.trim()) {
      try {
        const parsed = parseAck(x12);
        if (parsed.type === '277ca' && parsed.claims.length) {
          const claimIds = parsed.claims.map((c) => Number(c.claimId)).filter(Number.isFinite);
          const rows = claimIds.length
            ? db.prepare(`SELECT DISTINCT last_batch_id, org_id FROM claims WHERE id IN (${claimIds.map(() => '?').join(',')}) AND last_batch_id IS NOT NULL`).all(...claimIds)
            : [];
          if (rows.length === 1 && rows[0].last_batch_id) {
            const batch = db.prepare('SELECT * FROM claim_batches WHERE id = ?').get(rows[0].last_batch_id);
            if (batch && ['transmitted', 'acknowledged', 'partial'].includes(batch.status)) {
              applyAckToBatch(batch.org_id, batch, parsed, x12, '277ca');
              orgId = batch.org_id;
              batchId = batch.id;
              processed = 1;
              note = `277CA applied to batch ${batch.batch_number} → ${parsed.batchStatus}`;
            } else {
              note = '277CA parsed but batch not in an ack-accepting state';
            }
          } else {
            note = '277CA parsed; claims span multiple batches or no batch — recorded only';
          }
        } else {
          note = 'inline X12 was not a 277CA — recorded only';
        }
      } catch (e) {
        note = `inline X12 processing failed: ${e.message}`;
      }
    } else {
      note = 'event recorded; no inline X12 payload (retrieve via Stedi or upload the ack file)';
    }
  }

  try {
    db.prepare(`
      INSERT INTO stedi_events (event_type, transaction_id, org_id, batch_id, payload_json, processed, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventType, transactionId, orgId, batchId, rawBody.toString('utf-8').slice(0, 100000), processed, note);
  } catch (e) {
    console.error('[stedi-webhook] failed to record event:', e.message);
  }
  res.json({ received: true, processed: !!processed });
}

module.exports = { handleStediWebhook };
