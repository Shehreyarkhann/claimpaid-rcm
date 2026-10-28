// Email service for ClaimPaid (MFA codes, password resets, notifications).
//
// Providers (EMAIL_PROVIDER env):
//   console — logs the email to the server console (default, for development)
//   smtp    — sends via any SMTP server (Resend, SendGrid, Postmark, Gmail...)
//             Configure: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//             (SMTP_SECURE=true for implicit TLS ports like 465/2465;
//              STARTTLS otherwise. NOTE: DigitalOcean blocks outbound
//              25/465/587 on this droplet — production uses Resend's
//              alternate STARTTLS port 2587.)
//
// Production: Resend (resend.com) — domain claimpaid.io verified (SPF/DKIM),
// API key as SMTP password, user "resend", from no-reply@claimpaid.io.

let transporter = null;

function getProvider() {
  return (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
}

async function getTransporter() {
  if (getProvider() !== 'smtp') return null;
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
    // Never let a stalled SMTP connection hang a user request (the 2026-10-26
    // forgot-password hang): fail fast instead.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporter;
}

async function sendEmail({ to, subject, text, html }) {
  const provider = getProvider();
  if (provider === 'console') {
    console.log('\n========== [EMAIL:console] ==========');
    console.log(`To: ${to}\nSubject: ${subject}\n`);
    console.log(text);
    console.log('=====================================\n');
    return { provider, sent: true, dev: true };
  }

  if (provider === 'smtp') {
    if (!process.env.SMTP_HOST) throw new Error('SMTP_HOST is not configured');
    const t = await getTransporter();
    const from = process.env.SMTP_FROM || 'ClaimPaid <no-reply@claimpaid.io>';
    await t.sendMail({ from, to, subject, text, html: html || text });
    return { provider, sent: true };
  }

  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

// Branded HTML shell shared by all transactional mail: navy header with the
// official ClaimPaid logo, white content card, trust footer.
function layout(innerHtml, note) {
  return (
    `<div style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">` +
    `<tr><td style="background:#0B1220;padding:20px 28px">` +
    `<img src="https://claimpaid.io/claimpaid-logo-reverse.png" alt="ClaimPaid" width="239" height="60" style="vertical-align:middle">` +
    `</td></tr>` +
    `<tr><td style="padding:28px;color:#0f172a;font-size:15px;line-height:1.55">${innerHtml}</td></tr>` +
    `<tr><td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.5">` +
    `ClaimPaid — Get your claims paid.<br>` +
    `<a href="https://claimpaid.io" style="color:#059669;text-decoration:none">claimpaid.io</a> · Questions? Email us at support@claimpaid.io<br>` +
    `<span>${note}</span>` +
    `</td></tr></table></div>`
  );
}

async function sendMfaCode(email, code, name) {
  const first = (name || 'there').split(' ')[0];
  const subject = `Your ClaimPaid verification code: ${code}`;
  const text =
    `Hi ${first},\n\n` +
    `Your ClaimPaid verification code is:\n\n    ${code}\n\n` +
    `This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.\n\n` +
    `— The ClaimPaid Team`;
  const inner =
    `<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">Your verification code</h2>` +
    `<p style="margin:0 0 8px">Hi ${first},</p>` +
    `<p style="margin:0">Enter this code to finish signing in to ClaimPaid:</p>` +
    `<div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#059669;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:18px;text-align:center;margin:20px 0">${code}</div>` +
    `<p style="margin:0;color:#64748b;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`;
  const html = layout(inner, 'This is an automated security email from ClaimPaid.');
  return sendEmail({ to: email, subject, text, html });
}

async function sendPasswordReset(email, resetUrl, name) {
  const first = (name || 'there').split(' ')[0];
  const subject = 'Reset your ClaimPaid password';
  const text =
    `Hi ${first},\n\n` +
    `We received a request to reset your ClaimPaid password. Open the link below to set a new one:\n\n${resetUrl}\n\n` +
    `This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password will not change.\n\n` +
    `— The ClaimPaid Team`;
  const inner =
    `<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">Reset your password</h2>` +
    `<p style="margin:0 0 8px">Hi ${first},</p>` +
    `<p style="margin:0">We received a request to reset the password for your ClaimPaid account. Click the button below to set a new one:</p>` +
    `<a href="${resetUrl}" style="display:inline-block;background:#10B981;color:#ffffff;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;margin:20px 0">Set new password</a>` +
    `<p style="margin:0 0 6px;color:#64748b;font-size:13px">Or copy and paste this link into your browser:</p>` +
    `<p style="margin:0 0 16px;font-size:13px;word-break:break-all"><a href="${resetUrl}" style="color:#059669">${resetUrl}</a></p>` +
    `<p style="margin:0;color:#64748b;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password will not change.</p>`;
  const html = layout(inner, 'This email was sent because a password reset was requested for your ClaimPaid account.');
  return sendEmail({ to: email, subject, text, html });
}

module.exports = { sendEmail, sendMfaCode, sendPasswordReset, getProvider, layout };
