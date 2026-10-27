// ─────────────────────────────────────────────────────────────────────────────
// src/routes/billingRoutes.js — mounted at /api/billing
//   POST /google-play/verify          requireAuth  (Android app)
//   GET  /entitlements                requireAuth
//   POST /google-play/rtdn            Pub/Sub OIDC (Google only)
//   POST /admin/reconcile-voided      requireAdmin
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../middleware/firebaseAuth');
const { createPubsubAuth } = require('../middleware/pubsubAuth');
const { PRODUCT_IDS } = require('../config/playCatalog');
const controller = require('../controllers/billingController');

const router = express.Router();

// Per-user limiter (falls back to IP) — the app legitimately retries.
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many purchase verifications. Please wait a few minutes.' },
});
const entitlementsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait a moment.' },
});

function validateVerify(req, res, next) {
  const { productId, purchaseToken } = req.body ?? {};
  if (typeof productId !== 'string' || !PRODUCT_IDS.includes(productId)) {
    return res.status(400).json({ success: false, code: 'UNKNOWN_PRODUCT', error: 'Invalid productId.' });
  }
  if (typeof purchaseToken !== 'string' || purchaseToken.length < 20 || purchaseToken.length > 4096) {
    return res.status(400).json({ success: false, code: 'INVALID_TOKEN', error: 'Invalid purchaseToken.' });
  }
  next();
}

router.post('/google-play/verify', verifyLimiter, requireAuth, validateVerify, controller.verify);
router.get('/entitlements', entitlementsLimiter, requireAuth, controller.entitlements);
router.post('/google-play/rtdn', createPubsubAuth(), controller.rtdn);
router.post('/admin/reconcile-voided', requireAdmin, controller.reconcileVoided);

module.exports = router;
module.exports.validateVerify = validateVerify;
