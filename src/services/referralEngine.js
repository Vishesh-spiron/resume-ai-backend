// ─────────────────────────────────────────────────────────────────────────────
// src/services/referralEngine.js
// Phase 2 — the money-moving half of the referral program. Every function
// here either reads authoritative state or writes it inside a Firestore
// transaction; nothing here ever trusts a client-supplied amount.
//
// Owns: campaign config, discount eligibility, commission crediting,
// releasing matured holds, and reversing commissions on refund.
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db } = require('../config/firebaseAdmin');
const { queueNotification } = require('./notificationService');

const CONFIG_COLLECTION = 'config';
const CONFIG_DOC_ID = 'referral_campaign';

// Sensible launch defaults — matches the spec's "Launch Offer" section.
// Every value here is meant to be edited later from the Phase 5 admin panel
// without touching code.
const DEFAULT_CONFIG = {
  active: true,
  discountPercent: 10, // new customer's first-purchase discount
  commissionPercent: 20, // referrer's commission, off the ORIGINAL price
  minWithdrawal: 500, // ₹500, per spec
  holdDays: 7, // commission hold before it's withdrawable
  maxCommissionPerReferral: null, // ₹ ceiling per commission event; null = uncapped
  startDate: null, // ISO string or null = no start restriction
  endDate: null, // ISO string or null = no end restriction
};

let cachedConfig = null;
let cachedAt = 0;
const CACHE_MS = 60 * 1000; // config rarely changes; avoids a Firestore read per quote/order

function configRef() {
  return db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC_ID);
}

async function getCampaignConfig() {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_MS) return cachedConfig;

  const snap = await configRef().get();
  if (!snap.exists) {
    // Seed defaults on first run so there's something to read/edit later.
    await configRef().set(DEFAULT_CONFIG);
    cachedConfig = { ...DEFAULT_CONFIG };
  } else {
    cachedConfig = { ...DEFAULT_CONFIG, ...snap.data() };
  }
  cachedAt = now;
  return cachedConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Updates campaign config from the Phase 5 admin panel. Validates every
// field server-side (percentages in range, dates parseable) rather than
// trusting whatever the admin UI sends — the admin screen is trusted to be
// used by you, but the request itself still goes over the network and
// shouldn't be able to write garbage into the one doc every price/commission
// calculation reads from.
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_CONFIG_FIELDS = [
  'active', 'discountPercent', 'commissionPercent', 'minWithdrawal',
  'holdDays', 'maxCommissionPerReferral', 'startDate', 'endDate',
];

function validateConfigUpdate(updates) {
  const clean = {};
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_CONFIG_FIELDS.includes(key)) continue; // silently ignore unknown fields
    const value = updates[key];

    switch (key) {
      case 'active':
        if (typeof value !== 'boolean') return { error: '"active" must be true or false.' };
        clean.active = value;
        break;
      case 'discountPercent':
      case 'commissionPercent':
        if (typeof value !== 'number' || value < 0 || value > 100) {
          return { error: `"${key}" must be a number between 0 and 100.` };
        }
        clean[key] = value;
        break;
      case 'minWithdrawal':
        if (typeof value !== 'number' || value < 0) {
          return { error: '"minWithdrawal" must be a non-negative number.' };
        }
        clean.minWithdrawal = value;
        break;
      case 'holdDays':
        if (typeof value !== 'number' || value < 0 || !Number.isInteger(value)) {
          return { error: '"holdDays" must be a non-negative whole number.' };
        }
        clean.holdDays = value;
        break;
      case 'maxCommissionPerReferral':
        if (value !== null && (typeof value !== 'number' || value < 0)) {
          return { error: '"maxCommissionPerReferral" must be a non-negative number or null.' };
        }
        clean.maxCommissionPerReferral = value;
        break;
      case 'startDate':
      case 'endDate':
        if (value !== null && Number.isNaN(new Date(value).getTime())) {
          return { error: `"${key}" must be a valid date or null.` };
        }
        clean[key] = value;
        break;
    }
  }
  return { clean };
}

async function updateCampaignConfig(updates) {
  const { clean, error } = validateConfigUpdate(updates || {});
  if (error) return { success: false, error };
  if (Object.keys(clean).length === 0) {
    return { success: false, error: 'No valid fields to update.' };
  }

  await configRef().set(clean, { merge: true });
  cachedConfig = null; // force a fresh read next time, rather than waiting out CACHE_MS
  cachedAt = 0;
  return { success: true, config: await getCampaignConfig() };
}

function isCampaignLive(config) {
  if (!config.active) return false;
  const now = Date.now();
  if (config.startDate && now < new Date(config.startDate).getTime()) return false;
  if (config.endDate && now > new Date(config.endDate).getTime()) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing quote — used by BOTH the /quote endpoint (for display, before the
// user commits) and createOrder (for the actual charge), so the two can
// never drift apart. Read-only; no side effects.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateDiscount(uid, originalAmountPaise) {
  const config = await getCampaignConfig();

  if (!uid || !isCampaignLive(config)) {
    return { eligible: false, discountPercent: 0, finalAmountPaise: originalAmountPaise, config };
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const referredBy = userSnap.exists ? userSnap.data().referredBy : null;
  if (!referredBy) {
    return { eligible: false, discountPercent: 0, finalAmountPaise: originalAmountPaise, config };
  }

  const priorPurchase = await db.collection('purchases')
    .where('uid', '==', uid)
    .where('status', '==', 'completed')
    .limit(1)
    .get();
  if (!priorPurchase.empty) {
    return { eligible: false, discountPercent: 0, finalAmountPaise: originalAmountPaise, config };
  }

  const discountPercent = config.discountPercent;
  const finalAmountPaise = Math.round(originalAmountPaise * (1 - discountPercent / 100));
  return { eligible: true, discountPercent, finalAmountPaise, config, referrerUid: referredBy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Records a completed purchase and, if this is the buyer's first purchase
// AND they were referred, credits the referrer's commission — all as ONE
// atomic Firestore transaction. This is what makes "duplicate commission
// credits must be prevented" actually true under concurrent/retried calls:
// every read this needs (has this payment already been recorded? is this
// their first purchase? who's the referrer?) happens before any write, so
// Firestore can safely retry the whole thing as a unit on conflict.
//
// razorpayPaymentId is used as the `purchases` doc ID — Razorpay payment IDs
// are globally unique, so this alone gives idempotency against retries.
// ─────────────────────────────────────────────────────────────────────────────
async function recordPurchaseAndCredit({
  uid,
  planKey,
  originalAmountPaise,
  chargedAmountPaise,
  razorpayOrderId,
  razorpayPaymentId,
}) {
  const config = await getCampaignConfig(); // outside the tx — cached, rarely changes
  const purchaseRef = db.collection('purchases').doc(razorpayPaymentId);

  return db.runTransaction(async (tx) => {
    // ── ALL READS FIRST (Firestore transaction requirement) ─────────────────
    const existingPurchase = await tx.get(purchaseRef);
    if (existingPurchase.exists) {
      return { status: 'ALREADY_RECORDED' };
    }

    let userSnap = null;
    let priorPurchasesSnap = null;
    if (uid) {
      userSnap = await tx.get(db.collection('users').doc(uid));
      priorPurchasesSnap = await tx.get(
        db.collection('purchases').where('uid', '==', uid).where('status', '==', 'completed'),
      );
    }

    const referrerUid = userSnap && userSnap.exists ? userSnap.data().referredBy || null : null;
    const isFirstPurchase = uid ? (priorPurchasesSnap ? priorPurchasesSnap.empty : true) : false;
    const shouldCredit = isFirstPurchase && !!referrerUid && isCampaignLive(config);

    let referrerRef = null;
    let referrerSnap = null;
    if (shouldCredit) {
      referrerRef = db.collection('users').doc(referrerUid);
      referrerSnap = await tx.get(referrerRef); // still a read — must precede writes below
    }

    const referredUserName = userSnap && userSnap.exists ? (userSnap.data().name || 'A referred user') : 'A referred user';

    // ── NOW WRITES ───────────────────────────────────────────────────────────
    const discountApplied = chargedAmountPaise < originalAmountPaise;
    const discountAmountPaise = Math.max(0, originalAmountPaise - chargedAmountPaise);

    tx.set(purchaseRef, {
      uid: uid || null,
      planKey,
      originalAmount: originalAmountPaise / 100,
      chargedAmount: chargedAmountPaise / 100,
      discountApplied,
      // Stored directly (not derived at read time) so Phase 5's "Total
      // discounts given" analytics can sum it with an aggregation query
      // instead of fetching and adding up every purchase document.
      discountAmount: discountAmountPaise / 100,
      razorpayOrderId,
      razorpayPaymentId,
      status: 'completed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (shouldCredit && referrerSnap && referrerSnap.exists) {
      let commissionPaise = Math.round(originalAmountPaise * (config.commissionPercent / 100));
      if (config.maxCommissionPerReferral) {
        commissionPaise = Math.min(commissionPaise, Math.round(config.maxCommissionPerReferral * 100));
      }
      const commissionRupees = commissionPaise / 100;
      const holdUntil = new Date(Date.now() + config.holdDays * 24 * 60 * 60 * 1000).toISOString();

      tx.update(referrerRef, {
        walletBalance: admin.firestore.FieldValue.increment(commissionRupees),
        pendingBalance: admin.firestore.FieldValue.increment(commissionRupees),
        lifetimeEarnings: admin.firestore.FieldValue.increment(commissionRupees),
      });

      const txRef = db.collection('referral_transactions').doc();
      tx.set(txRef, {
        referrerId: referrerUid,
        referredUserId: uid,
        referredUserName,
        purchaseId: razorpayPaymentId,
        planName: planKey,
        originalAmount: originalAmountPaise / 100,
        discountedAmount: chargedAmountPaise / 100,
        commission: commissionRupees,
        status: 'pending', // released once holdUntil passes — see releaseMaturedHolds
        holdUntil,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // One combined notification, not two — "first purchase" and "commission
      // credited" are the same trigger in this design (commission is only
      // ever credited on a first purchase), so a separate message for each
      // would just be the same news twice.
      queueNotification(tx, {
        uid: referrerUid,
        type: 'commission_credited',
        message: `\ud83d\udcb0 ${referredUserName} made their first purchase \u2014 \u20b9${commissionRupees.toFixed(2)} commission credited to your wallet!`,
      });

      return { status: 'CREDITED', referrerUid, commissionRupees, transactionId: txRef.id };
    }

    return { status: 'RECORDED_NO_CREDIT' };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Moves any of this user's matured (past-hold) pending commissions into the
// withdrawable pool. Pull-based by design — there's no job scheduler in this
// app, so rather than relying on a cron that might silently stop running,
// this runs inline whenever the wallet is read (see getWallet). Cheap: only
// touches transactions still marked 'pending'.
// ─────────────────────────────────────────────────────────────────────────────
async function releaseMaturedHolds(uid) {
  const now = new Date();
  const pendingSnap = await db.collection('referral_transactions')
    .where('referrerId', '==', uid)
    .where('status', '==', 'pending')
    .get();

  const matured = pendingSnap.docs.filter((d) => new Date(d.data().holdUntil) <= now);
  if (matured.length === 0) return { released: 0 };

  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    // Re-read inside the tx so this is safe even if something else touched
    // the wallet between the query above and now.
    const freshDocs = await Promise.all(matured.map((d) => tx.get(d.ref)));
    let releasedTotal = 0;
    freshDocs.forEach((snap) => {
      if (snap.exists && snap.data().status === 'pending') {
        tx.update(snap.ref, { status: 'completed' });
        releasedTotal += snap.data().commission;
      }
    });
    if (releasedTotal > 0) {
      tx.update(userRef, { pendingBalance: admin.firestore.FieldValue.increment(-releasedTotal) });
    }
  });

  return { released: matured.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverses a commission when its underlying purchase is refunded (called
// from the Razorpay webhook). Clamps at zero rather than letting a balance
// go negative if the referrer already withdrew the money — and leaves a
// note on the transaction so that shortfall is visible for manual follow-up
// instead of silently vanishing.
// ─────────────────────────────────────────────────────────────────────────────
async function reverseCommissionForPurchase(razorpayPaymentId) {
  const purchaseRef = db.collection('purchases').doc(razorpayPaymentId);
  const txQuery = db.collection('referral_transactions')
    .where('purchaseId', '==', razorpayPaymentId)
    .where('status', 'in', ['pending', 'completed'])
    .limit(1);

  return db.runTransaction(async (tx) => {
    // ── reads ──
    const purchaseSnap = await tx.get(purchaseRef);
    const txSnap = await tx.get(txQuery);

    if (purchaseSnap.exists && purchaseSnap.data().status !== 'refunded') {
      tx.update(purchaseRef, { status: 'refunded' });
    }

    if (txSnap.empty) {
      return { reversed: false, reason: 'NO_REFERRAL_TRANSACTION' };
    }

    const referralTxDoc = txSnap.docs[0];
    const { referrerId, commission, status } = referralTxDoc.data();
    const referrerRef = db.collection('users').doc(referrerId);
    const referrerSnap = await tx.get(referrerRef);

    if (!referrerSnap.exists) {
      tx.update(referralTxDoc.ref, { status: 'refunded' });
      return { reversed: false, reason: 'REFERRER_NOT_FOUND' };
    }

    // ── writes ──
    const data = referrerSnap.data();
    const currentBalance = data.walletBalance || 0;
    const currentPending = data.pendingBalance || 0;
    const currentLifetime = data.lifetimeEarnings || 0;
    const shortfall = commission - currentBalance;

    tx.update(referrerRef, {
      walletBalance: Math.max(0, currentBalance - commission),
      lifetimeEarnings: Math.max(0, currentLifetime - commission),
      // Only claw back from pendingBalance if this commission was still on
      // hold — if it already cleared, pendingBalance shouldn't move.
      pendingBalance: status === 'pending' ? Math.max(0, currentPending - commission) : currentPending,
    });

    tx.update(referralTxDoc.ref, {
      status: 'refunded',
      ...(shortfall > 0
        ? {
            reconciliationNote: `Reversal of \u20b9${commission} exceeded available balance by \u20b9${shortfall.toFixed(2)} \u2014 referrer had likely already withdrawn this commission. Needs manual review.`,
          }
        : {}),
    });

    return { reversed: true, referrerId, commission, shortfall: Math.max(0, shortfall) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Creates a withdrawal request. Doesn't move any money — per spec, payouts
// stay manual for now ("Do not implement automatic payouts yet") — this just
// records the request for an admin to act on later (Phase 5). Enforces:
//   - only one PENDING request per user at a time (the only real protection
//     against over-requesting, since there's no separate "reserved" bucket)
//   - requested amount is between minWithdrawal and the user's current
//     withdrawable balance (recomputed fresh, never trusted from the client)
// ─────────────────────────────────────────────────────────────────────────────
async function createWithdrawalRequest(uid, requestedAmount) {
  await releaseMaturedHolds(uid); // fresh numbers before checking eligibility
  const config = await getCampaignConfig();

  const userRef = db.collection('users').doc(uid);
  const existingPendingQuery = db.collection('withdrawal_requests')
    .where('userId', '==', uid)
    .where('status', '==', 'pending');

  return db.runTransaction(async (tx) => {
    // ── reads ──
    const userSnap = await tx.get(userRef);
    const pendingSnap = await tx.get(existingPendingQuery);

    if (!userSnap.exists) return { success: false, error: 'User profile not found.' };
    if (!pendingSnap.empty) {
      return { success: false, error: 'You already have a pending withdrawal request.' };
    }

    const data = userSnap.data();
    const walletBalance = data.walletBalance || 0;
    const pendingBalance = data.pendingBalance || 0;
    const withdrawable = Math.max(0, walletBalance - pendingBalance);

    if (!requestedAmount || requestedAmount <= 0) {
      return { success: false, error: 'Enter a valid amount.' };
    }
    if (requestedAmount < config.minWithdrawal) {
      return { success: false, error: `Minimum withdrawal amount is \u20b9${config.minWithdrawal}.` };
    }
    if (requestedAmount > withdrawable) {
      return { success: false, error: `You can withdraw up to \u20b9${withdrawable.toFixed(2)} right now.` };
    }

    // ── writes ──
    const requestRef = db.collection('withdrawal_requests').doc();
    tx.set(requestRef, {
      userId: uid,
      name: data.name || 'Unknown',
      email: data.email || '',
      walletBalance, // snapshot at request time, for the admin's reference
      requestedAmount,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
    });

    queueNotification(tx, {
      uid,
      type: 'withdrawal_submitted',
      message: `Your withdrawal request for \u20b9${requestedAmount.toFixed(2)} has been submitted and is pending review.`,
    });

    return { success: true, requestId: requestRef.id };
  });
}

module.exports = {
  getCampaignConfig,
  updateCampaignConfig,
  isCampaignLive,
  evaluateDiscount,
  recordPurchaseAndCredit,
  releaseMaturedHolds,
  reverseCommissionForPurchase,
  createWithdrawalRequest,
};
