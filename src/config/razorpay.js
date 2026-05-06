// ─────────────────────────────────────────────────────────────────────────────
// src/config/razorpay.js
// Initializes the Razorpay SDK with credentials from environment variables.
// The SECRET KEY never leaves this file — never sent to the client.
// ─────────────────────────────────────────────────────────────────────────────

const Razorpay = require('razorpay');

// Validate that required keys exist at startup
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('❌ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing from .env');
  process.exit(1); // Stop server immediately — no point running without keys
}

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,     // rzp_test_xxx or rzp_live_xxx
  key_secret: process.env.RAZORPAY_KEY_SECRET, // NEVER exposed to client
});

module.exports = razorpay;
