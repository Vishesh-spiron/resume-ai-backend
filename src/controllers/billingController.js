// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/billingController.js
// HTTP layer for Google Play billing. Business logic lives in
// services/playBillingService.js. Never logs full purchase tokens.
// ─────────────────────────────────────────────────────────────────────────────
const { admin, db } = require('../config/firebaseAdmin');
const { getPublisher, getPackageName, isGooglePlayConfigured } = require('../config/googlePlay');
const { createFirestoreStore } = require('../services/playPurchaseStore');
const { createPlayBillingService, BillingError } = require('../services/playBillingService');
const { getProduct } = require('../config/playCatalog');

let service = null;

function getService() {
  if (service) return service;
  const { recordPurchaseAndCredit, reverseCommissionForPurchase } = require('../services/referralEngine');
  service = createPlayBillingService({
    store: createFirestoreStore(db),
    getPublisher,
    packageName: getPackageName(),
    hooks: {
      // Referral commission bookkeeping (existing behaviour, best-effort).
      // Doc id keeps the legacy 'gp_<sha256>' scheme in the `purchases` collection.
      async onPurchaseRecorded({ uid, productId, purchaseId, orderId }) {
        const product = getProduct(productId);
        const docId = `gp_${purchaseId}`;
        await recordPurchaseAndCredit({
          uid,
          planKey: product.planKey,
          originalAmountPaise: product.intendedPricePaise,
          chargedAmountPaise: product.intendedPricePaise,
          razorpayOrderId: orderId,
          razorpayPaymentId: docId,
        });
        await db.collection('purchases').doc(docId).set(
          {
            provider: 'google_play',
            productId,
            googleOrderId: orderId || null,
            razorpayOrderId: admin.firestore.FieldValue.delete(),
            razorpayPaymentId: admin.firestore.FieldValue.delete(),
          },
          { merge: true },
        );
      },
      async onPurchaseVoided({ purchaseId }) {
        await reverseCommissionForPurchase(`gp_${purchaseId}`);
      },
    },
  });
  return service;
}

function sendError(req, res, err) {
  if (err instanceof BillingError) {
    const body = { success: false, code: err.code, error: err.message };
    if (err.pending) body.pending = true;
    if (err.retryable) body.retryable = true;
    if (err.entitlements) {
      body.entitlements = err.entitlements;
      body.products = err.products;
    }
    if (err.misconfigured) {
      console.error(`[${req.requestId}] ❌ Play API refused the service account — check API enablement, Play Console permissions and GOOGLE_PLAY_PACKAGE_NAME.`);
    }
    return res.status(err.httpStatus).json(body);
  }
  console.error(`[${req.requestId}] ❌ billing error: ${err.message}`);
  return res.status(500).json({ success: false, code: 'INTERNAL', error: 'Billing error. Please try again.', retryable: true });
}

function notConfigured(req, res) {
  console.error(`[${req.requestId}] ❌ Google Play billing not configured (GOOGLE_PLAY_PACKAGE_NAME / service account).`);
  return res.status(503).json({
    success: false,
    code: 'BILLING_NOT_CONFIGURED',
    retryable: true,
    error: 'Purchase verification is temporarily unavailable.',
  });
}

// POST /api/billing/google-play/verify  { productId, purchaseToken }
async function verify(req, res) {
  if (!isGooglePlayConfigured()) return notConfigured(req, res);
  try {
    const { productId, purchaseToken } = req.body;
    const result = await getService().verifyAndGrant({ uid: req.uid, productId, purchaseToken });
    return res.json({ success: true, productId, ...result });
  } catch (err) {
    return sendError(req, res, err);
  }
}

// GET /api/billing/entitlements
async function entitlements(req, res) {
  try {
    const result = await getService().getEntitlementsForUser(req.uid);
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendError(req, res, err);
  }
}

// POST /api/billing/google-play/rtdn   (Pub/Sub push; authenticated by pubsubAuth)
async function rtdn(req, res) {
  if (!isGooglePlayConfigured()) return res.status(503).end();
  const message = req.body?.message;
  if (!message?.data) return res.status(400).json({ error: 'Malformed push.' });
  let payload;
  try {
    payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch (_) {
    return res.status(204).end(); // undecodable: retrying will never help
  }
  try {
    await getService().handleNotification({ messageId: message.messageId, payload });
    return res.status(204).end();
  } catch (err) {
    console.error(`[${req.requestId}] ❌ RTDN processing failed (${err.code || err.message}) — will be redelivered`);
    return res.status(500).end(); // non-2xx → Pub/Sub retries with backoff
  }
}

// POST /api/billing/admin/reconcile-voided   (admin only)
async function reconcileVoided(req, res) {
  if (!isGooglePlayConfigured()) return notConfigured(req, res);
  try {
    const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 30);
    const result = await getService().reconcileVoided({ startTimeMs: Date.now() - days * 86400000 });
    return res.json({ success: true, ...result });
  } catch (err) {
    return sendError(req, res, err);
  }
}

module.exports = { verify, entitlements, rtdn, reconcileVoided, sendError };
