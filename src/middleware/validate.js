// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/validate.js
// Lightweight request body validation — keeps controllers clean.
// ─────────────────────────────────────────────────────────────────────────────

// Valid plan keys — must match Flutter PaymentPlan enum keys
const VALID_PLANS = ['fixResume', 'jdOptimize', 'bundle', 'humanReview', 'resumeGenerator'];

// Amount map in paise (₹1 = 100 paise) — single source of truth on server
// This means clients CANNOT manipulate the price — server decides the amount
const PLAN_AMOUNTS = {
  fixResume:   3900,   // ₹39
  jdOptimize:  4900,   // ₹49
  bundle:      7900,   // ₹89
  humanReview:      12900,  // ₹129
  resumeGenerator:   4900,   // ₹49
};

/**
 * Validates POST /create-order body.
 * Expects: { plan: string }
 * Rejects if plan is missing or not one of the valid plan keys.
 * Sets req.amountInPaise so the controller doesn't need to look it up.
 */
function validateCreateOrder(req, res, next) {
  const { plan } = req.body;

  if (!plan) {
    return res.status(400).json({ error: 'Missing required field: plan' });
  }

  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({
      error: `Invalid plan "${plan}". Must be one of: ${VALID_PLANS.join(', ')}`,
    });
  }

  // Attach server-side amount to request — controller uses this, not client input
  req.amountInPaise = PLAN_AMOUNTS[plan];
  req.planKey       = plan;
  next();
}

/**
 * Validates POST /verify-payment body.
 * Expects: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
function validateVerifyPayment(req, res, next) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id) {
    return res.status(400).json({ error: 'Missing: razorpay_order_id' });
  }
  if (!razorpay_payment_id) {
    return res.status(400).json({ error: 'Missing: razorpay_payment_id' });
  }
  if (!razorpay_signature) {
    return res.status(400).json({ error: 'Missing: razorpay_signature' });
  }

  // Basic format check — Razorpay IDs always start with "order_" or "pay_"
  if (!razorpay_order_id.startsWith('order_')) {
    return res.status(400).json({ error: 'Invalid razorpay_order_id format' });
  }
  if (!razorpay_payment_id.startsWith('pay_')) {
    return res.status(400).json({ error: 'Invalid razorpay_payment_id format' });
  }

  next();
}

module.exports = { validateCreateOrder, validateVerifyPayment };
