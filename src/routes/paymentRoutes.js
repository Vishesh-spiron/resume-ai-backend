// ─────────────────────────────────────────────────────────────────────────────
// src/routes/paymentRoutes.js
// Wires rate limiting → validation → controller for all payment endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { createOrder, verifyPayment, handleWebhook } = require('../controllers/paymentController');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');
const { paymentLimiter, verifyLimiter }          = require('../middleware/rateLimit');
const { optionalAuth }                           = require('../middleware/firebaseAuth');

// POST /api/payment/create-order
// Rate limited → identify user if possible (never blocks) → validated → order created
router.post('/create-order', paymentLimiter, optionalAuth, validateCreateOrder, createOrder);

// POST /api/payment/verify-payment
// Stricter rate limit → identify user if possible → validated → HMAC verified
router.post('/verify-payment', verifyLimiter, optionalAuth, validateVerifyPayment, verifyPayment);

// POST /api/payment/webhook — Razorpay server calling us, not the Flutter app.
// No optionalAuth (there's no Firebase user here) and no rate limiting
// (Razorpay's own servers call this, not end users). Signature is verified
// inside handleWebhook using RAZORPAY_WEBHOOK_SECRET + the raw body index.js
// captures for this path.
router.post('/webhook', handleWebhook);

module.exports = router;
