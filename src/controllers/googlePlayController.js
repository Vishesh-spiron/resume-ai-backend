// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/googlePlayController.js
// Verifies Google Play in-app purchases made in the Android app, then grants
// the unlock. (Web payments still go through paymentController.js / Razorpay.)
//
// POST /api/payment/google-play/verify        (requireAuth — Firebase ID token)
//   Flutter sends:  { productId: "fix_resume", purchaseToken: "..." }
//
// What "verify" means here — the client is never trusted:
//   1. Look the purchase up on Google's servers (purchases.products.get).
//   2. It must be in the PURCHASED state and belong to the signed-in user.
//   3. Acknowledge it (Google refunds unacknowledged purchases after 3 days).
//   4. Record it in `purchases` (idempotent — the token hash is the doc id) and
//      credit any referral commission, exactly like a Razorpay purchase.
//   5. Write the unlock into `unlocks/{uid}` with the Admin SDK.
// Retrying is always safe: every step is idempotent.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { admin, db } = require('../config/firebaseAdmin');
const { getPublisher, getPackageName, isGooglePlayConfigured } = require('../config/googlePlay');
const { recordPurchaseAndCredit } = require('../services/referralEngine');
const { PLAN_AMOUNTS } = require('../middleware/validate');

// Play Console product id  →  backend plan key + which Firestore `unlocks`
// entries it grants. `unlocks` keys are the ones the Flutter app reads
// (UnlockNotifier in premium_providers.dart).
//
// Keep the product ids in sync with PaymentPlanX.playProductId in
// payment_service.dart, and the plan keys with validate.js VALID_PLANS.
const PLAY_PRODUCTS = {
  fix_resume:       { planKey: 'fixResume',       unlocks: ['fix_resume'] },
  jd_optimize:      { planKey: 'jdOptimize',      unlocks: ['jd_optimize'] },
  bundle:           { planKey: 'bundle',          unlocks: ['fix_resume', 'jd_optimize', 'resume_generator', 'human_review', 'bundle'] },
  human_review:     { planKey: 'humanReview',     unlocks: ['human_review'] },
  resume_generator: { planKey: 'resumeGenerator', unlocks: ['resume_generator'] },
  interview_prep:   { planKey: 'interviewPrep',   unlocks: ['interview_prep'] },
};

// purchases.products.get → purchaseState
const STATE_PURCHASED = 0;
const STATE_PENDING   = 2;
// purchases.products.get → acknowledgementState
const ACK_YET_TO_BE   = 0;

// Purchase tokens are long and can contain characters Firestore doc ids don't
// like, so the doc id is a hash. `gp_` keeps it distinct from Razorpay ids.
function purchaseDocId(purchaseToken) {
  return 'gp_' + crypto.createHash('sha256').update(purchaseToken).digest('hex');
}

async function grantUnlocks(uid, unlockKeys) {
  await db.collection('unlocks').doc(uid).set(
    {
      plans: admin.firestore.FieldValue.arrayUnion(...unlockKeys),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

function googleErrorInfo(err) {
  const status = err.code || err.response?.status;
  const message = err.response?.data?.error?.message || err.message;
  return { status: Number(status) || 0, message };
}

// Acknowledge, tolerating the "someone else already did" race (client retry,
// the on-device completePurchase call, or a parallel verify request).
async function ensureAcknowledged({ publisher, packageName, productId, token, purchase }) {
  if (purchase.acknowledgementState !== ACK_YET_TO_BE) return;
  try {
    await publisher.purchases.products.acknowledge({
      packageName,
      productId,
      token,
      requestBody: {},
    });
  } catch (ackErr) {
    const { data } = await publisher.purchases.products.get({ packageName, productId, token });
    if (data.acknowledgementState === ACK_YET_TO_BE) throw ackErr; // genuinely failed
  }
}

async function verifyGooglePlayPurchase(req, res) {
  const { requestId, uid } = req;
  const { productId, purchaseToken } = req.body;

  const product = PLAY_PRODUCTS[productId];
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product.' });
  }

  if (!isGooglePlayConfigured()) {
    console.error(
      `[${requestId}] ❌ Google Play verification is not configured — set GOOGLE_PLAY_PACKAGE_NAME and a service account (GOOGLE_PLAY_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT).`,
    );
    return res.status(503).json({
      success: false,
      error: 'Purchase verification is not configured on the server yet.',
    });
  }

  const docId = purchaseDocId(purchaseToken);
  const purchaseRef = db.collection('purchases').doc(docId);

  try {
    // ── 1. Already redeemed? (retries, recovery, another account) ───────────
    const existing = await purchaseRef.get();
    if (existing.exists) {
      const data = existing.data();
      if (data.uid && data.uid !== uid) {
        console.warn(`[${requestId}] ⚠️  Play token already redeemed by another account | product=${productId}`);
        return res.status(409).json({
          success: false,
          error: 'This purchase is already linked to a different account.',
        });
      }
      if (data.status === 'refunded') {
        return res.status(403).json({ success: false, error: 'This purchase was refunded.' });
      }
      await grantUnlocks(uid, product.unlocks); // heals a missing unlock
      console.log(`[${requestId}] ↩️  Play purchase already recorded — unlock re-granted | product=${productId}`);
      return res.json({ success: true, productId, plan: product.planKey, alreadyRecorded: true });
    }

    // ── 2. Ask Google ───────────────────────────────────────────────────────
    const publisher = getPublisher();
    const packageName = getPackageName();
    let purchase;
    try {
      const { data } = await publisher.purchases.products.get({
        packageName,
        productId,
        token: purchaseToken,
      });
      purchase = data;
    } catch (apiErr) {
      const { status, message } = googleErrorInfo(apiErr);
      if (status === 400 || status === 404 || status === 410) {
        console.warn(`[${requestId}] ⚠️  Google rejected purchase lookup (${status}): ${message}`);
        return res.status(400).json({ success: false, error: 'Purchase could not be verified.' });
      }
      if (status === 401 || status === 403) {
        console.error(
          `[${requestId}] ❌ Play API refused the service account (${status}): ${message} — ` +
          `check: Android Publisher API enabled, service account invited in Play Console with ` +
          `"View financial data" + "Manage orders and subscriptions", GOOGLE_PLAY_PACKAGE_NAME correct.`,
        );
      }
      throw apiErr;
    }

    // ── 3. Is it really a completed purchase, by this user? ─────────────────
    if (purchase.purchaseState === STATE_PENDING) {
      return res.status(202).json({
        success: false,
        pending: true,
        error: 'Payment is still pending with Google Play.',
      });
    }
    if (purchase.purchaseState !== STATE_PURCHASED) {
      return res.status(400).json({ success: false, error: 'This purchase was cancelled or refunded.' });
    }
    if (purchase.obfuscatedExternalAccountId && purchase.obfuscatedExternalAccountId !== uid) {
      console.warn(`[${requestId}] ⚠️  Play purchase belongs to a different account id | product=${productId}`);
      return res.status(403).json({
        success: false,
        error: 'This purchase belongs to a different account.',
      });
    }

    // ── 4. Acknowledge (else Google auto-refunds after 3 days) ──────────────
    await ensureAcknowledged({ publisher, packageName, productId, token: purchaseToken, purchase });

    // ── 5. Record + referral commission (idempotent, one transaction) ───────
    // Play charges its fixed list price, so original == charged (the referral
    // discount is a Razorpay-only feature; commissions still credit).
    const amountPaise = PLAN_AMOUNTS[product.planKey];
    let outcome = { status: 'RECORDED_NO_CREDIT' };
    try {
      outcome = await recordPurchaseAndCredit({
        uid,
        planKey: product.planKey,
        originalAmountPaise: amountPaise,
        chargedAmountPaise: amountPaise,
        razorpayOrderId: purchase.orderId || '',
        razorpayPaymentId: docId, // reused as the purchases doc id → idempotency
      });
    } catch (bookkeepingErr) {
      // Money has changed hands and Google has confirmed it: never fail the
      // user's unlock because referral bookkeeping hiccuped.
      console.error(`[${requestId}] ❌ purchase bookkeeping failed (unlock still granted): ${bookkeepingErr.message}`);
    }

    // recordPurchaseAndCredit is shared with Razorpay and writes Razorpay-named
    // fields — relabel this doc so analytics can tell the two apart.
    try {
      await purchaseRef.set(
        {
          provider: 'google_play',
          productId,
          googleOrderId: purchase.orderId || null,
          isTestPurchase: purchase.purchaseType === 0,
          razorpayOrderId: admin.firestore.FieldValue.delete(),
          razorpayPaymentId: admin.firestore.FieldValue.delete(),
        },
        { merge: true },
      );
    } catch (annotateErr) {
      console.warn(`[${requestId}] ⚠️  could not annotate purchase doc: ${annotateErr.message}`);
    }

    if (outcome.status === 'CREDITED') {
      console.log(
        `[${requestId}] 💰 Commission credited | referrer=${outcome.referrerUid} referred=${uid} amount=₹${outcome.commissionRupees}`,
      );
    }

    // ── 6. Grant the unlock (server-side write) ─────────────────────────────
    await grantUnlocks(uid, product.unlocks);

    console.log(
      `[${requestId}] ✅ Play purchase verified | product=${productId} uid=${uid} order=${purchase.orderId || 'n/a'}` +
      (purchase.purchaseType === 0 ? ' (test purchase)' : ''),
    );

    return res.json({ success: true, productId, plan: product.planKey });
  } catch (err) {
    const { status, message } = googleErrorInfo(err);
    console.error(`[${requestId}] ❌ google-play verify failed | product=${productId} | ${status || ''} ${message}`);
    return res.status(500).json({
      success: false,
      error: 'Purchase verification error. Please try again in a moment.',
    });
  }
}

module.exports = { verifyGooglePlayPurchase, PLAY_PRODUCTS };
