// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/firebaseAuth.js
// Verifies the Firebase ID token the Flutter app sends on referral/wallet
// requests, so the backend knows WHO is calling without trusting a
// client-supplied uid (which could be spoofed).
//
// Flutter side:  final token = await FirebaseAuth.instance.currentUser?.getIdToken();
//                headers: { 'Authorization': 'Bearer $token' }
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db, isFirebaseReady } = require('../config/firebaseAdmin');

async function requireAuth(req, res, next) {
  if (!isFirebaseReady()) {
    return res.status(503).json({
      error: 'Referral system is not configured on the server yet.',
    });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      error: 'Missing Authorization header (Bearer <Firebase ID token>).',
    });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email || null;
    next();
  } catch (err) {
    console.warn(`[${req.requestId}] ⚠️  Token verification failed: ${err.message}`);
    return res.status(401).json({
      error: 'Invalid or expired session. Please sign in again.',
    });
  }
}

// Best-effort identity check — used on payment endpoints, which must keep
// working (at full price, no referral eligibility) even if the token is
// missing, expired, or Firebase Admin isn't configured yet. NEVER blocks
// the request; only ever enriches it with req.uid when possible.
async function optionalAuth(req, res, next) {
  if (!isFirebaseReady()) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return next();

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.userEmail = decoded.email || null;
  } catch (err) {
    console.warn(`[${req.requestId}] \u26a0\ufe0f  optionalAuth: ignoring invalid token (${err.message})`);
    // Deliberately no response here — fall through unauthenticated.
  }
  next();
}

// Requires a verified token AND that user's Firestore doc to have
// role === 'admin'. Used for the referral program's admin endpoints
// (campaign config, analytics, withdrawal approval) — none of this is
// safe to expose to a regular signed-in user, only requireAuth's identity
// check would not be enough on its own.
async function requireAdmin(req, res, next) {
  if (!isFirebaseReady()) {
    return res.status(503).json({ error: 'Referral system is not configured on the server yet.' });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header (Bearer <Firebase ID token>).' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const userDoc = await db.collection('users').doc(decoded.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    req.uid = decoded.uid;
    req.userEmail = decoded.email || null;
    next();
  } catch (err) {
    console.warn(`[${req.requestId}] \u26a0\ufe0f  requireAdmin: token verification failed (${err.message})`);
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
