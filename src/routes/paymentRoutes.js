// ─────────────────────────────────────────────────────────────────────────────
// src/routes/paymentRoutes.js
// Wires rate limiting → validation → controller for all payment endpoints.
//
//   Web      → Razorpay:      /create-order, /verify-payment, /webhook
//   Android  → Google Play:   /google-play/verify
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const router    = express.Router();

const { createOrder, verifyPayment, handleWebhook } = require('../controllers/paymentController');
const billingController                           = require('../controllers/billingController');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');
const { paymentLimiter, verifyLimiter }          = require('../middleware/rateLimit');
const { optionalAuth, requireAuth }              = require('../middleware/firebaseAuth');

// POST /api/payment/create-order
// Rate limited → identify user if possible (never blocks) → validated → order created
router.post('/create-order', paymentLimiter, optionalAuth, validateCreateOrder, createOrder);

// POST /api/payment/verify-payment
// Stricter rate limit → identify user if possible → validated → HMAC verified
router.post('/verify-payment', verifyLimiter, optionalAuth, validateVerifyPayment, verifyPayment);

// Deprecated alias kept for already-installed app builds: forwards to the
// new billing controller (POST /api/billing/google-play/verify). Product IDs
// are the Play Console IDs in config/playCatalog.js.
const { validateVerify } = require('./billingRoutes');
router.post('/google-play/verify', requireAuth, validateVerify, billingController.verify);

// POST /api/payment/webhook — Razorpay server calling us, not the Flutter app.
// No optionalAuth (there's no Firebase user here) and no rate limiting
// (Razorpay's own servers call this, not end users). Signature is verified
// inside handleWebhook using RAZORPAY_WEBHOOK_SECRET + the raw body index.js
// captures for this path.
router.post('/webhook', handleWebhook);

module.exports = router;
