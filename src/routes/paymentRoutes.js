// ─────────────────────────────────────────────────────────────────────────────
// src/routes/paymentRoutes.js
// Wires rate limiting → validation → controller for all payment endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { createOrder, verifyPayment }             = require('../controllers/paymentController');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');
const { paymentLimiter, verifyLimiter }          = require('../middleware/rateLimit');

// POST /api/payment/create-order
// Rate limited → validated → order created
router.post('/create-order', paymentLimiter, validateCreateOrder, createOrder);

// POST /api/payment/verify-payment
// Stricter rate limit → validated → HMAC verified
router.post('/verify-payment', verifyLimiter, validateVerifyPayment, verifyPayment);

module.exports = router;
