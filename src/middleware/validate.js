// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/validate.js
// Lightweight request body validation — keeps controllers clean.
// ─────────────────────────────────────────────────────────────────────────────

// Valid plan keys — must match Flutter PaymentPlan.planKey values exactly
const VALID_PLANS = [
  'fixResume',
  'jdOptimize',
  'bundle',
  'humanReview',
  'resumeGenerator',
];

// ── Single source of truth for pricing (paise) ────────────────────────────────
// ₹1 = 100 paise. Server decides the price — clients CANNOT send an amount.
// If Flutter's PaymentPlan.amountInPaise ever differs from these values,
// the backend wins. Update both together when prices change.
const PLAN_AMOUNTS = {
  fixResume:       3900,   // ₹39
  jdOptimize:      4900,   // ₹49
  bundle:          7900,   // ₹79 — save ₹187 vs buying separately
  humanReview:    12900,   // ₹129
  resumeGenerator: 4900,   // ₹49
};

// ── Input sanitization ────────────────────────────────────────────────────────
// Strip anything that isn't alphanumeric — prevents injection via plan field.
function sanitizePlan(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}

/**
 * Validates POST /create-order body.
 * Expects: { plan: string }
 * Rejects if plan is missing, invalid, or not in the approved list.
 * Attaches req.amountInPaise and req.planKey for the controller.
 */
function validateCreateOrder(req, res, next) {
  const raw = req.body?.plan;

  if (!raw) {
    return res.status(400).json({ error: 'Missing required field: plan' });
  }

  const plan = sanitizePlan(raw);

  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({
      error: `Invalid plan "${plan}". Must be one of: ${VALID_PLANS.join(', ')}`,
    });
  }

  // Attach server-side values — controller never reads from req.body.amount
  req.amountInPaise = PLAN_AMOUNTS[plan];
  req.planKey       = plan;
  next();
}

/**
 * Validates POST /verify-payment body.
 * Expects: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Performs format checks so the controller only handles verified-shape data.
 */
function validateVerifyPayment(req, res, next) {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body ?? {};

  if (!razorpay_order_id)
    return res.status(400).json({ error: 'Missing: razorpay_order_id' });
  if (!razorpay_payment_id)
    return res.status(400).json({ error: 'Missing: razorpay_payment_id' });
  if (!razorpay_signature)
    return res.status(400).json({ error: 'Missing: razorpay_signature' });

  // Razorpay IDs always start with 'order_' / 'pay_' — reject anything else
  if (typeof razorpay_order_id !== 'string' || !razorpay_order_id.startsWith('order_'))
    return res.status(400).json({ error: 'Invalid razorpay_order_id format' });
  if (typeof razorpay_payment_id !== 'string' || !razorpay_payment_id.startsWith('pay_'))
    return res.status(400).json({ error: 'Invalid razorpay_payment_id format' });

  // Signature must be a 64-char hex string (SHA256 HMAC output)
  if (typeof razorpay_signature !== 'string' || !/^[a-f0-9]{64}$/i.test(razorpay_signature))
    return res.status(400).json({ error: 'Invalid razorpay_signature format' });

  next();
}

module.exports = { validateCreateOrder, validateVerifyPayment, PLAN_AMOUNTS, VALID_PLANS };
