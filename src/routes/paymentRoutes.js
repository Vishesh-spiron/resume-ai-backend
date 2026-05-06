// ─────────────────────────────────────────────────────────────────────────────
// src/routes/paymentRoutes.js
// Wires middleware → controllers for all payment endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { createOrder, verifyPayment }           = require('../controllers/paymentController');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');

// POST /api/payment/create-order
// Validate body first, then create the Razorpay order
router.post('/create-order', validateCreateOrder, createOrder);

// POST /api/payment/verify-payment
// Validate body first, then verify HMAC signature
router.post('/verify-payment', validateVerifyPayment, verifyPayment);

module.exports = router;
