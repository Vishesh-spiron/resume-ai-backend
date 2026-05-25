// src/config/emailer.js
// ─────────────────────────────────────────────────────────────────────────────
// Resend client — replaces Nodemailer + Gmail SMTP.
//
// WHY RESEND INSTEAD OF NODEMAILER + GMAIL:
//   Render free tier blocks outbound SMTP connections (ports 25, 465, 587).
//   Resend uses HTTPS API — never blocked by any hosting platform.
//   Free tier: 100 emails/day, 3,000/month. No credit card needed.
//
// SETUP (2 minutes):
//   1. Go to https://resend.com → Sign up free
//   2. API Keys → Create API Key → copy it
//   3. Add to Render env vars: RESEND_API_KEY=re_xxxxxxxxxx
//
// SENDER ADDRESS:
//   Free tier: you MUST use "onboarding@resend.dev" as the from address
//   OR verify your own domain (free) at resend.com/domains.
//   Recommended: verify your domain so emails come from your own address.
//   Until then, set RESEND_FROM=onboarding@resend.dev in your .env
// ─────────────────────────────────────────────────────────────────────────────

const { Resend } = require('resend');

let _client = null;

function getResendClient() {
  if (!_client) {
    _client = new Resend(process.env.RESEND_API_KEY);
  }
  return _client;
}

// Called at startup — non-fatal if key is missing
async function verifyEmailer() {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set — Human Review emails will fail.');
    console.warn('   Get a free key at https://resend.com');
    return;
  }
  // Resend has no "verify" call — just confirm key is set
  console.log('✅ Resend configured —', process.env.RESEND_FROM || 'onboarding@resend.dev');
}

module.exports = { getResendClient, verifyEmailer };
