// ─────────────────────────────────────────────────────────────────────────────
// src/config/firebaseAdmin.js
// Initializes Firebase Admin so this backend can read/write the SAME
// Firestore project the Flutter app already uses (project: next-hire-62f3f).
//
// This is what lets referral discounts, commissions, and wallet balances be
// verified and written SERVER-SIDE instead of trusting the Flutter client —
// which matters because a client can always be reverse-engineered to call
// Firestore directly with fake numbers.
//
// IMPORTANT — this module NEVER crashes the process if credentials are
// missing. Payment, AI, and human-review routes must keep working exactly
// as they do today even if the referral system isn't configured yet.
// Only the /api/referral/* and (later) referral-aware payment routes will
// respond with 503 until FIREBASE_SERVICE_ACCOUNT is set.
//
// ── How to get the credential (one-time) ──────────────────────────────────
// 1. Firebase Console → next-hire-62f3f → Project settings → Service accounts
// 2. Click "Generate new private key" → downloads a JSON file
// 3. Base64-encode it and set it as FIREBASE_SERVICE_ACCOUNT in your .env
//    (base64 avoids newline/quote-escaping issues with .env files):
//      macOS/Linux:  base64 -i serviceAccountKey.json | tr -d '\n'
//      Windows PS :  [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccountKey.json"))
// 4. Paste the output as FIREBASE_SERVICE_ACCOUNT=<that long string>
// 5. Add the same env var on Render (or wherever this is deployed).
// NEVER commit the JSON key or the base64 string to Git.
// ─────────────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');

let db = null;
let firebaseReady = false;
let firebaseInitError = null;

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;

  try {
    // Accept either raw JSON (starts with "{") or base64-encoded JSON.
    const jsonStr = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (err) {
    firebaseInitError = `FIREBASE_SERVICE_ACCOUNT is set but could not be parsed (${err.message}). Check it's valid base64 or JSON.`;
    return null;
  }
}

try {
  const serviceAccount = loadServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    firebaseReady = true;
    console.log(`✅ Firebase Admin initialized — project: ${serviceAccount.project_id}`);
  } else if (!firebaseInitError) {
    firebaseInitError = 'FIREBASE_SERVICE_ACCOUNT env var not set.';
  }
} catch (err) {
  firebaseInitError = `Firebase Admin init failed: ${err.message}`;
}

if (!firebaseReady) {
  console.warn(`⚠️  Referral system disabled — ${firebaseInitError}`);
  console.warn('   Payment, AI, and human-review routes are unaffected.');
}

module.exports = {
  admin,
  db,
  isFirebaseReady: () => firebaseReady,
  firebaseInitError: () => firebaseInitError,
};
