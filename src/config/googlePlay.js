// ─────────────────────────────────────────────────────────────────────────────
// src/config/googlePlay.js
// Google Play Developer API client — used ONLY to verify and acknowledge
// in-app purchases made in the Android app. Web payments (Razorpay) never
// touch this file.
//
// Lazy on purpose: nothing here runs at startup, so a missing/invalid Play
// credential can never stop the server (payments on web, AI, referrals all
// keep working). The /google-play/verify route just returns a clear 503 until
// this is configured.
//
// ── One-time setup ──────────────────────────────────────────────────────────
// 1. Google Cloud Console → (same project as Firebase is fine) → APIs & Services
//    → enable "Google Play Android Developer API".
// 2. Use a service account from that project. The Firebase Admin one you
//    already have in FIREBASE_SERVICE_ACCOUNT works, or create a dedicated
//    one and put its JSON (raw or base64) in GOOGLE_PLAY_SERVICE_ACCOUNT.
// 3. Play Console → Users and permissions → Invite new users → paste the
//    service account's email → give it access to your app with permission
//    "View financial data" + "Manage orders and subscriptions".
// 4. Set GOOGLE_PLAY_PACKAGE_NAME to your Android applicationId,
//    e.g. com.enqusoft.resumeai (Play Console → your app → App details).
// NEVER commit the JSON key. Access can take a little while to propagate.
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require('googleapis');

let publisher = null;

function loadCredentials() {
  const raw =
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // Accept raw JSON (starts with "{") or base64-encoded JSON — same as
    // firebaseAdmin.js.
    const jsonStr = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `Google Play service account could not be parsed (${err.message}). Check it's valid JSON or base64.`,
    );
  }
}

function getPackageName() {
  return (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
}

function isGooglePlayConfigured() {
  return Boolean(
    getPackageName() &&
      (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT),
  );
}

function getPublisher() {
  if (publisher) return publisher;
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error('No Google Play service account configured.');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  publisher = google.androidpublisher({ version: 'v3', auth });
  return publisher;
}

module.exports = { getPublisher, getPackageName, isGooglePlayConfigured };
