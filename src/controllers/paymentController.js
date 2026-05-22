// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/paymentController.js
// Handles Razorpay order creation and HMAC signature verification.
// ─────────────────────────────────────────────────────────────────────────────

const crypto   = require('crypto');
const razorpay = require('../config/razorpay');

// Human-readable plan names shown in Razorpay dashboard receipts.
// Keep in sync with Flutter PaymentPlan.title and validate.js VALID_PLANS.
const PLAN_NAMES = {
  fixResume:       'Fix My Resume',
  jdOptimize:      'JD Optimization',
  bundle:          'Full Upgrade Bundle',
  humanReview:     'Expert Human Review',
  resumeGenerator: 'AI Resume Builder',   // ← was missing before
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order
//
// Flutter sends:  { plan: "fixResume" }
// We return:      { success, order_id, amount, currency, plan, plan_name, key_id }
//
// Server sets the price — the client never sends an amount.
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder(req, res) {
  // amountInPaise and planKey are set by validateCreateOrder middleware
  const { amountInPaise, planKey, requestId } = req;

  try {
    const options = {
      amount:   amountInPaise,
      currency: 'INR',
      // Unique receipt ID for your Razorpay dashboard — never shown to user
      receipt: `rcpt_${planKey}_${Date.now()}`,
      notes: {
        plan:       planKey,
        plan_name:  PLAN_NAMES[planKey],
        source:     'resume_ai_flutter',
        request_id: requestId,
      },
    };

    const order = await razorpay.orders.create(options);

    console.log(
      `[${requestId}] ✅ Order created | id=${order.id} plan=${planKey} ₹${amountInPaise / 100}`,
    );

    // Return only what Flutter needs — NEVER return your secret key
    return res.json({
      success:   true,
      order_id:  order.id,
      amount:    order.amount,      // paise
      currency:  order.currency,
      plan:      planKey,
      plan_name: PLAN_NAMES[planKey],
      key_id:    process.env.RAZORPAY_KEY_ID, // Safe — this is the PUBLIC key
    });

  } catch (err) {
    console.error(`[${requestId}] ❌ create-order failed | plan=${planKey} | ${err.message}`);
    return res.status(500).json({
      success: false,
      error:   'Failed to create payment order. Please try again.',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify-payment
//
// Flutter sends after Razorpay checkout completes:
//   { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//
// HMAC verification:
//   payload  = order_id + "|" + payment_id
//   expected = HMAC-SHA256(payload, RAZORPAY_KEY_SECRET)
//   valid    = timingSafeEqual(expected, received_signature)
//
// timingSafeEqual prevents timing attacks where an attacker guesses
// the signature one byte at a time by measuring response latency.
// ─────────────────────────────────────────────────────────────────────────────
async function verifyPayment(req, res) {
  const { requestId } = req;
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body;

  try {
    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(payload)
      .digest('hex');

    // Buffers must be the same byte length for timingSafeEqual
    const receivedBuf = Buffer.from(razorpay_signature, 'hex');
    const expectedBuf = Buffer.from(expectedSig,        'hex');

    if (receivedBuf.length !== expectedBuf.length) {
      console.warn(
        `[${requestId}] ⚠️  Signature length mismatch | order=${razorpay_order_id}`,
      );
      return res.status(400).json({
        success: false,
        error:   'Payment verification failed — signature length mismatch.',
      });
    }

    const isValid = crypto.timingSafeEqual(receivedBuf, expectedBuf);

    if (!isValid) {
      console.warn(
        `[${requestId}] ⚠️  Signature mismatch | order=${razorpay_order_id} pay=${razorpay_payment_id}`,
      );
      return res.status(400).json({
        success: false,
        error:   'Payment verification failed — signature mismatch.',
      });
    }

    console.log(
      `[${requestId}] ✅ Payment verified | pay=${razorpay_payment_id} order=${razorpay_order_id}`,
    );

    return res.json({
      success:    true,
      payment_id: razorpay_payment_id,
      order_id:   razorpay_order_id,
      message:    'Payment verified successfully',
    });

  } catch (err) {
    console.error(
      `[${requestId}] ❌ verify-payment error | order=${razorpay_order_id} | ${err.message}`,
    );
    return res.status(500).json({
      success: false,
      error:   'Payment verification error. Please contact support.',
    });
  }
}

module.exports = { createOrder, verifyPayment };
