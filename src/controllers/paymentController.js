// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/paymentController.js
// Handles Razorpay order creation and HMAC signature verification.
//
// Phase 2 addition: referral discount at order-creation time, purchase
// recording + commission crediting at verify-payment time, and a webhook
// that reverses commission if the underlying payment is later refunded.
// ─────────────────────────────────────────────────────────────────────────────

const crypto   = require('crypto');
const razorpay = require('../config/razorpay');
const { isFirebaseReady } = require('../config/firebaseAdmin');
const { evaluateDiscount, recordPurchaseAndCredit, reverseCommissionForPurchase } = require('../services/referralEngine');

// Human-readable plan names shown in Razorpay dashboard receipts.
// Keep in sync with Flutter PaymentPlan.title and validate.js VALID_PLANS.
const PLAN_NAMES = {
  fixResume:       'Fix My Resume',
  jdOptimize:      'JD Optimization',
  bundle:          'Full Upgrade Bundle',
  humanReview:     'Expert Human Review',
  resumeGenerator: 'AI Resume Builder',   // ← was missing before
  interviewPrep:   'Interview Prep Report',
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order                    (optionalAuth — req.uid may be unset)
//
// Flutter sends:  { plan: "fixResume" }
// We return:      { success, order_id, amount, currency, plan, plan_name, key_id,
//                   original_amount, discount_percent, discount_applied }
//
// Server sets the price — the client never sends an amount. If req.uid is
// set (valid Firebase token) and they're a referred first-time buyer during
// an active campaign, `amount` here is already the discounted price — the
// SAME evaluateDiscount() call the /quote endpoint uses, so what Flutter
// showed the user before checkout always matches what Razorpay charges.
// ─────────────────────────────────────────────────────────────────────────────
async function createOrder(req, res) {
  // amountInPaise and planKey are set by validateCreateOrder middleware
  const { amountInPaise, planKey, requestId, uid } = req;

  try {
    let finalAmountPaise = amountInPaise;
    let discountPercent = 0;
    let discountApplied = false;

    if (isFirebaseReady()) {
      try {
        const quote = await evaluateDiscount(uid, amountInPaise);
        finalAmountPaise = quote.finalAmountPaise;
        discountPercent = quote.discountPercent;
        discountApplied = quote.eligible;
      } catch (quoteErr) {
        // Never let a referral lookup failure block checkout — fall back to full price.
        console.warn(`[${requestId}] \u26a0\ufe0f  evaluateDiscount failed, charging full price: ${quoteErr.message}`);
      }
    }

    const options = {
      amount:   finalAmountPaise,
      currency: 'INR',
      // Unique receipt ID for your Razorpay dashboard — never shown to user
      receipt: `rcpt_${planKey}_${Date.now()}`,
      notes: {
        plan:             planKey,
        plan_name:        PLAN_NAMES[planKey],
        source:           'resume_ai_flutter',
        request_id:       requestId,
        original_amount:  String(amountInPaise),
        discount_applied: String(discountApplied),
      },
    };

    const order = await razorpay.orders.create(options);

    console.log(
      `[${requestId}] ✅ Order created | id=${order.id} plan=${planKey} ₹${finalAmountPaise / 100}` +
      (discountApplied ? ` (₹${amountInPaise / 100} \u2192 ${discountPercent}% off)` : ''),
    );

    // Return only what Flutter needs — NEVER return your secret key
    return res.json({
      success:   true,
      order_id:  order.id,
      amount:    order.amount,      // paise — the ACTUAL amount Razorpay will charge
      currency:  order.currency,
      plan:      planKey,
      plan_name: PLAN_NAMES[planKey],
      key_id:    process.env.RAZORPAY_KEY_ID, // Safe — this is the PUBLIC key
      original_amount:   amountInPaise / 100,      // ₹, for showing a strikethrough price
      discount_percent:  discountPercent,
      discount_applied:  discountApplied,
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
  const { requestId, uid } = req;
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

    // ── Referral Program: record the purchase + credit commission ──────────
    // Signature is valid from here on, so the user always gets a success
    // response — anything below is best-effort bookkeeping, never a reason
    // to fail the payment back to the user.
    if (isFirebaseReady()) {
      try {
        // Fetch the order from Razorpay itself (never trust the client for
        // plan/amount at the point money actually changes hands) — the
        // `notes` we attached in createOrder come back here.
        const order = await razorpay.orders.fetch(razorpay_order_id);
        const planKey = order.notes?.plan;
        const originalAmountPaise = Number(order.notes?.original_amount) || order.amount;
        const chargedAmountPaise = order.amount;

        if (planKey) {
          const outcome = await recordPurchaseAndCredit({
            uid: uid || null,
            planKey,
            originalAmountPaise,
            chargedAmountPaise,
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
          });

          if (outcome.status === 'CREDITED') {
            console.log(
              `[${requestId}] 💰 Commission credited | referrer=${outcome.referrerUid} ` +
              `referred=${uid} amount=₹${outcome.commissionRupees}`,
            );
          } else if (outcome.status === 'ALREADY_RECORDED') {
            console.log(`[${requestId}] \u2139\ufe0f  Duplicate verify-payment for ${razorpay_payment_id} — already recorded, skipping.`);
          }
        } else {
          console.warn(`[${requestId}] \u26a0\ufe0f  Order ${razorpay_order_id} has no plan in notes — skipping purchase record.`);
        }
      } catch (referralErr) {
        // Never let referral bookkeeping failures affect the user-facing result.
        console.error(`[${requestId}] \u274c referral bookkeeping failed (payment itself is still valid): ${referralErr.message}`);
      }
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/webhook                              (Razorpay calls this)
//
// Handles refund events so "Refunded payments automatically reverse the
// commission" is actually true, not just documented. Verified using
// RAZORPAY_WEBHOOK_SECRET (set this up in Razorpay Dashboard → Webhooks →
// pointing at <your-backend-url>/api/payment/webhook, events:
// "refund.created" and "payment.refunded" — the secret shown there is what
// goes in this env var).
//
// Needs the RAW request body for signature verification — see index.js,
// which captures req.rawBody alongside the normal parsed req.body.
// ─────────────────────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const requestId = req.requestId || 'webhook';
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    console.warn(`[${requestId}] \u26a0\ufe0f  Webhook received but RAZORPAY_WEBHOOK_SECRET is not set — ignoring.`);
    return res.status(503).json({ error: 'Webhook not configured.' });
  }
  if (!isFirebaseReady()) {
    console.warn(`[${requestId}] \u26a0\ufe0f  Webhook received but referral system is not configured — ignoring.`);
    return res.status(503).json({ error: 'Referral system not configured.' });
  }

  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody;

    if (!signature || !rawBody) {
      console.warn(`[${requestId}] \u26a0\ufe0f  Webhook missing signature or raw body.`);
      return res.status(400).json({ error: 'Missing signature.' });
    }

    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const validSig = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!validSig) {
      console.warn(`[${requestId}] \u26a0\ufe0f  Webhook signature mismatch — ignoring.`);
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const event = req.body?.event;
    const paymentId = req.body?.payload?.payment?.entity?.id;

    // Only refund events reverse a commission; everything else is ack'd and ignored.
    if ((event === 'refund.created' || event === 'payment.refunded') && paymentId) {
      const result = await reverseCommissionForPurchase(paymentId);
      console.log(`[${requestId}] \u21a9\ufe0f  Refund webhook (${event}) for ${paymentId} \u2014 reversed=${result.reversed}`);
    } else {
      console.log(`[${requestId}] Webhook event "${event}" received — no action needed.`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`[${requestId}] \u274c webhook processing failed: ${err.message}`);
    // 500 so Razorpay retries — this really might be a transient failure
    // (e.g. Firestore hiccup) rather than a bad event.
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

module.exports = { createOrder, verifyPayment, handleWebhook };
