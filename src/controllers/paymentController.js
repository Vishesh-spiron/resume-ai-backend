// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/paymentController.js
// Handles Razorpay order creation and HMAC signature verification.
// ─────────────────────────────────────────────────────────────────────────────

const crypto   = require('crypto');    // Built-in Node.js — no install needed
const razorpay = require('../config/razorpay');

// ── Plan display names for Razorpay checkout receipt ─────────────────────────
const PLAN_NAMES = {
  fixResume:   'Fix My Resume',
  jdOptimize:  'JD Optimization',
  bundle:      'Full Upgrade Bundle',
  humanReview: 'Expert Human Review',
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order
//
// Flutter sends:  { plan: "fixResume" }
// We return:      Razorpay order object (contains order_id, amount, currency)
//
// The Flutter app then opens Razorpay Checkout.js (web) or plugin (mobile)
// using this order_id to initiate the payment.
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder(req, res) {
  try {
    // Amount and plan key are set by validateCreateOrder middleware
    // We NEVER trust the client-sent amount — server decides the price
    const { amountInPaise, planKey } = req;

    const options = {
      amount:   amountInPaise,          // Amount in paise (₹39 = 3900)
      currency: 'INR',
      receipt:  `receipt_${planKey}_${Date.now()}`, // Unique receipt ID for your records
      notes: {
        plan: planKey,                  // Stored in Razorpay dashboard for reference
        source: 'resume_ai_flutter',
      },
    };

    const order = await razorpay.orders.create(options);

    console.log(`✅ Order created: ${order.id} | Plan: ${planKey} | ₹${amountInPaise / 100}`);

    // Return only what Flutter needs — never return your secret key
    res.json({
      success:       true,
      order_id:      order.id,
      amount:        order.amount,       // In paise
      currency:      order.currency,
      plan:          planKey,
      plan_name:     PLAN_NAMES[planKey],
      key_id:        process.env.RAZORPAY_KEY_ID, // Safe to send — public key only
    });

  } catch (err) {
    console.error('❌ create-order failed:', err.message);
    res.status(500).json({
      success: false,
      error:   'Failed to create payment order. Please try again.',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify-payment
//
// Flutter sends after user pays:
//   { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//
// How HMAC verification works:
//   1. We concatenate order_id + "|" + payment_id
//   2. We hash it using SHA256 with our SECRET KEY
//   3. If the result matches the signature Razorpay sent → payment is genuine
//   4. If not → someone tampered with the data
//
// This is the ONLY secure way to confirm a payment — never trust the client alone.
// ─────────────────────────────────────────────────────────────────────────────
async function verifyPayment(req, res) {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    // Build the string Razorpay uses to generate the signature
    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;

    // Generate our own HMAC using the SECRET KEY
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(payload)
      .digest('hex');

    // Use timingSafeEqual to prevent timing attacks
    // (prevents attackers from guessing the signature byte-by-byte)
    const sigBuffer      = Buffer.from(razorpay_signature,   'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    // Buffers must be same length for timingSafeEqual
    if (sigBuffer.length !== expectedBuffer.length) {
      console.warn(`⚠️  Signature length mismatch for order: ${razorpay_order_id}`);
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      // Signature mismatch — payment was tampered with or is fake
      console.warn(`⚠️  Invalid signature for order: ${razorpay_order_id}`);
      return res.status(400).json({
        success: false,
        error:   'Payment verification failed. Signature mismatch.',
      });
    }

    // ✅ Payment is genuine
    console.log(`✅ Payment verified: ${razorpay_payment_id} for order: ${razorpay_order_id}`);

    res.json({
      success:    true,
      payment_id: razorpay_payment_id,
      order_id:   razorpay_order_id,
      message:    'Payment verified successfully',
    });

  } catch (err) {
    console.error('❌ verify-payment failed:', err.message);
    res.status(500).json({
      success: false,
      error:   'Payment verification error. Please contact support.',
    });
  }
}

module.exports = { createOrder, verifyPayment };
