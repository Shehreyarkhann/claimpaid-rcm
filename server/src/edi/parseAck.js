// Acknowledgement parsers for claim transmission:
//   - 999 (005010X231A1): Implementation Acknowledgement — functional-level
//     accept/reject of the 837 transaction set (AK1/AK2/AK5).
//   - 277CA (005010X214): Claim Acknowledgement — claim-level accept/reject
//     with reason codes (2200D loop: TRN*1*<patient control number>, then STC).
//
// CLM01 in our 837P files is the app's claim id, and 277CA returns it in
// TRN02, so claims map back directly. Reason codes are always surfaced raw —
// the status mapping here is intentionally conservative (only an explicit
// accept category counts as accepted).

function splitSegments(text) {
  return String(text || '')
    .replace(/\r?\n/g, '')
    .split('~')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('*'));
}

function detectType(segs) {
  const st = segs.find((s) => s[0] === 'ST');
  const code = st && st[1];
  if (code === '999') return '999';
  if (code === '277') return '277ca';
  return 'unknown';
}

// ---- 999 -------------------------------------------------------------------

function parse999(segs) {
  const ak5s = segs.filter((s) => s[0] === 'AK5').map((s) => s[1]);
  const ak9 = segs.find((s) => s[0] === 'AK9');
  let functionalAck = 'accepted';
  if (ak5s.includes('R')) functionalAck = 'rejected';
  else if (ak5s.includes('E')) functionalAck = 'accepted_with_errors';
  else if (ak9 && ['R', 'P'].includes(ak9[1])) functionalAck = 'rejected';

  return {
    type: '999',
    functionalAck,
    ak5: ak5s,
    ak9: ak9 ? ak9.slice(1, 5) : [],
    // Batch-level outcome used by the batch workflow:
    // 999 acceptance = "acknowledged" (claim-level fate still unknown until 277CA)
    batchStatus: functionalAck === 'rejected' ? 'rejected' : 'acknowledged',
  };
}

// ---- 277CA -----------------------------------------------------------------
// 2200D loop shape (005010X214): TRN*1*<patient control number>*<payer id>
// followed by one or more STC segments. STC01 = "category:code:entity",
// e.g. "A1:20:PR" (accepted) or "A3:..." (rejected with reason codes).

const ACCEPT_CATEGORIES = new Set(['A1']); // explicit accept only

function parse277CA(segs) {
  const claims = [];
  let current = null;

  for (const s of segs) {
    if (s[0] === 'TRN' && s[1] === '1') {
      if (current) claims.push(current);
      current = { claimId: s[2], statuses: [] };
    } else if (s[0] === 'STC' && current) {
      const cat = String(s[1] || '').split(':')[0].trim();
      const status = ACCEPT_CATEGORIES.has(cat) ? 'accepted' : 'rejected';
      current.statuses.push({
        category: cat,
        statusCode: String(s[1] || '').split(':')[1] || '',
        status,
        raw: s.join('*'),
      });
    }
  }
  if (current) claims.push(current);

  const perClaim = claims.map((c) => {
    // First STC in the loop is the claim-level status; extras are informational.
    const first = c.statuses[0] || { category: '', statusCode: '', status: 'rejected', raw: '' };
    return {
      claimId: c.claimId,
      status: first.status,
      category: first.category,
      reasonCode: first.statusCode,
      detail: c.statuses.map((x) => x.raw),
    };
  });

  const accepted = perClaim.filter((c) => c.status === 'accepted').length;
  const rejected = perClaim.filter((c) => c.status === 'rejected').length;
  const batchStatus =
    perClaim.length === 0 ? 'acknowledged'
    : rejected === 0 ? 'accepted'
    : accepted === 0 ? 'rejected'
    : 'partial';

  return { type: '277ca', claims: perClaim, accepted, rejected, batchStatus };
}

// ---- entry point ------------------------------------------------------------

function parseAck(text) {
  const segs = splitSegments(text);
  if (!segs.length) throw new Error('Empty acknowledgement file');
  const type = detectType(segs);
  if (type === '999') return parse999(segs);
  if (type === '277ca') return parse277CA(segs);
  throw new Error(
    `Unrecognized acknowledgement type (expected 999 or 277CA, found ST*${(segs.find((s) => s[0] === 'ST') || [])[1] || '?'})`
  );
}

module.exports = { parseAck, splitSegments, detectType };
