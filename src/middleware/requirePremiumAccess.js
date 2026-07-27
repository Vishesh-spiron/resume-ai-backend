// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/requirePremiumAccess.js
//
// POST /api/ai/chat is a single generic proxy used by BOTH free features
// (the core resume-vs-job-role match flow, the guest ATS preview) and
// premium tools (fix resume, JD optimize, resume generator, ...). The two
// are told apart by a `feature` key in the request body — see
// config/premiumConfig.js#PREMIUM_FEATURES for the current allowlist and
// core/services/resume_improve_service.dart on the Flutter side for where
// that key gets attached.
//
// This middleware is a no-op for anything NOT in that allowlist, so it is
// always safe to mount on the shared /chat route — it never affects free
// traffic, including unauthenticated guest calls.
//
// Mount AFTER optionalAuth (so req.uid is populated when a token is
// present) and BEFORE the controller:
//   router.post('/chat', aiLimiter, optionalAuth, requirePremiumAccess, chatCompletion);
// ─────────────────────────────────────────────────────────────────────────────

const { PREMIUM_FEATURES } = require('../config/premiumConfig');
const { isFirebaseReady } = require('../config/firebaseAdmin');
const { getPremiumStatus } = require('../services/premiumService');

async function requirePremiumAccess(req, res, next) {
  const feature = req.body?.feature;

  // Free feature (or caller omitted the tag) — let it through untouched.
  if (!feature || !PREMIUM_FEATURES.includes(feature)) {
    return next();
  }

  if (!isFirebaseReady()) {
    // Fail CLOSED, not open: if we can't verify status, we must not grant
    // a premium feature. (Free features above never reach this branch.)
    console.error(`[${req.requestId}] \u274c requirePremiumAccess: Firebase Admin not configured — refusing premium feature "${feature}".`);
    return res.status(503).json({
      success: false,
      error: 'Premium verification is temporarily unavailable. Please try again shortly.',
    });
  }

  if (!req.uid) {
    return res.status(401).json({
      success: false,
      error: 'Please sign in to use this feature.',
    });
  }

  try {
    const account = await getPremiumStatus(req.uid);
    if (!account.canAccessPremium) {
      console.log(`[${req.requestId}] \ud83d\udd12 Premium feature "${feature}" blocked | uid=${req.uid} | not premium, no active unlock`);
      return res.status(403).json({
        success: false,
        code: 'PREMIUM_REQUIRED',
        error: 'This feature requires Premium or an active reward unlock.',
      });
    }
    return next();
  } catch (err) {
    console.error(`[${req.requestId}] \u274c requirePremiumAccess check failed: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not verify premium access.' });
  }
}

module.exports = { requirePremiumAccess };
