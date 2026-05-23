// src/config/emailer.js
// ─────────────────────────────────────────────────────────────────────────────
// Nodemailer transporter — used ONLY for Human Review emails with PDF attachment.
// Payment confirmation emails still go through EmailJS in Flutter.
//
// Configured from .env:
//   SMTP_HOST  → smtp.gmail.com (Gmail) or your mail server
//   SMTP_PORT  → 587 (STARTTLS, recommended) or 465 (SSL)
//   SMTP_USER  → your email address
//   SMTP_PASS  → Gmail app password or SMTP password
//   SMTP_FROM  → From address shown to recipient (can match SMTP_USER)
//
// Gmail setup (free, 500 emails/day):
//   1. Enable 2-Step Verification on your Google account
//   2. Go to https://myaccount.google.com/apppasswords
//   3. Generate → "Mail" → copy the 16-char password → paste as SMTP_PASS
//   Do NOT use your real Gmail password — it won't work with SMTP.
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Increase timeout for attachments — PDFs can take a moment
  connectionTimeout: 10_000,
  greetingTimeout:   10_000,
});

// ── Verify connection at startup ─────────────────────────────────────────────
// Called from index.js after all env vars are confirmed present.
async function verifyEmailer() {
  try {
    await transporter.verify();
    console.log('✅ SMTP connection verified —', process.env.SMTP_HOST);
  } catch (err) {
    // Non-fatal at startup — log clearly but don't crash the payment server
    console.warn('⚠️  SMTP verification failed:', err.message);
    console.warn('   Human Review emails will fail until SMTP is fixed.');
    console.warn('   Check SMTP_HOST / SMTP_USER / SMTP_PASS in .env');
  }
}

module.exports = { transporter, verifyEmailer };
