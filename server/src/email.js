// Email service for Pulse RCM (MFA codes, and future transactional mail).
//
// Providers (EMAIL_PROVIDER env):
//   console — logs the email to the server console (default, for development)
//   smtp    — sends via any SMTP server (Resend, SendGrid, Postmark, Gmail...)
//             Configure: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//             (SMTP_SECURE=true for port 465; STARTTLS otherwise)
//
// Production recommendation: Resend (resend.com) — free tier covers 3k emails/mo,
// create an API key, then use host smtp.resend.com, port 587, user "resend",
// pass = API key, from = onboarding@yourdomain.com (verify your domain first).

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
    const from = process.env.SMTP_FROM || 'Pulse RCM <no-reply@pulsercm.com>';
    await t.sendMail({ from, to, subject, text, html: html || text });
    return { provider, sent: true };
  }

  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

async function sendMfaCode(email, code, name) {
  const first = (name || 'there').split(' ')[0];
  const subject = `Your Pulse RCM verification code: ${code}`;
  const text =
    `Hi ${first},\n\n` +
    `Your Pulse RCM verification code is:\n\n    ${code}\n\n` +
    `This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.\n\n` +
    `— The Pulse RCM Team`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="color:#0f172a">Your verification code</h2>` +
    `<p>Hi ${first},</p>` +
    `<p>Enter this code to finish signing in to Pulse RCM:</p>` +
    `<div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#059669;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:20px;text-align:center;margin:20px 0">${code}</div>` +
    `<p style="color:#64748b;font-size:14px">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>` +
    `</div>`;
  return sendEmail({ to: email, subject, text, html });
}

async function sendPasswordReset(email, resetUrl, name) {
  const first = (name || 'there').split(' ')[0];
  const subject = 'Reset your Pulse RCM password';
  const text =
    `Hi ${first},\n\n` +
    `We received a request to reset your Pulse RCM password. Click the link below to set a new one:\n\n${resetUrl}\n\n` +
    `This link expires in 1 hour. If you didn't request this, you can safely ignore this email.\n\n` +
    `— The Pulse RCM Team`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="color:#0f172a">Reset your password</h2>` +
    `<p>Hi ${first},</p>` +
    `<p>Click the button below to set a new password for your Pulse RCM account:</p>` +
    `<a href="${resetUrl}" style="display:inline-block;background:#059669;color:#fff;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;margin:16px 0">Set new password</a>` +
    `<p style="color:#64748b;font-size:14px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>` +
    `</div>`;
  return sendEmail({ to: email, subject, text, html });
}

module.exports = { sendEmail, sendMfaCode, sendPasswordReset, getProvider };
