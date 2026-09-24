// ─────────────────────────────────────────────────────────────────────────────
// src/routes/paymentRoutes.js
// Wires rate limiting → validation → controller for all payment endpoints.
//
//   Web      → Razorpay:      /create-order, /verify-payment, /webhook
//   Android  → Google Play:   /google-play/verify
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const { createOrder, verifyPayment, handleWebhook } = require('../controllers/paymentController');
const { verifyGooglePlayPurchase }                  = require('../controllers/googlePlayController');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');
const { paymentLimiter, verifyLimiter }          = require('../middleware/rateLimit');
const { optionalAuth, requireAuth }              = require('../middleware/firebaseAuth');

// POST /api/payment/create-order
// Rate limited → identify user if possible (never blocks) → validated → order created
router.post('/create-order', paymentLimiter, optionalAuth, validateCreateOrder, createOrder);

// POST /api/payment/verify-payment
// Stricter rate limit → identify user if possible → validated → HMAC verified
router.post('/verify-payment', verifyLimiter, optionalAuth, validateVerifyPayment, verifyPayment);

// POST /api/payment/google-play/verify — Android app, after a Google Play purchase.
// Needs a real signed-in user (the unlock is written to THEIR account), so
// requireAuth, not optionalAuth. Own limiter: the app legitimately retries
// (server cold-start, purchase recovery), so it's looser than verifyLimiter's 5.
const googlePlayLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many purchase verifications. Please wait a few minutes.' },
});

function validateGooglePlayVerify(req, res, next) {
  const { productId, purchaseToken } = req.body ?? {};
  if (typeof productId !== 'string' || !/^[a-z0-9_.]{1,80}$/.test(productId)) {
    return res.status(400).json({ success: false, error: 'Invalid productId.' });
  }
  if (typeof purchaseToken !== 'string' || purchaseToken.length < 20 || purchaseToken.length > 4096) {
    return res.status(400).json({ success: false, error: 'Invalid purchaseToken.' });
  }
  next();
}

router.post(
  '/google-play/verify',
  googlePlayLimiter,
  requireAuth,
  validateGooglePlayVerify,
  verifyGooglePlayPurchase,
);

// POST /api/payment/webhook — Razorpay server calling us, not the Flutter app.
// No optionalAuth (there's no Firebase user here) and no rate limiting
// (Razorpay's own servers call this, not end users). Signature is verified
// inside handleWebhook using RAZORPAY_WEBHOOK_SECRET + the raw body index.js
// captures for this path.
router.post('/webhook', handleWebhook);

module.exports = router;
