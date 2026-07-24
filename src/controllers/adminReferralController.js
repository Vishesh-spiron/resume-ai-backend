// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/adminReferralController.js
// Phase 5 — everything gated behind requireAdmin: editing campaign config,
// the analytics rollup, and reviewing/approving withdrawal requests.
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db } = require('../config/firebaseAdmin');
const { AggregateField } = require('firebase-admin/firestore');
const { getCampaignConfig, updateCampaignConfig } = require('../services/referralEngine');
const { queueNotification } = require('../services/notificationService');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/referral/config
// ─────────────────────────────────────────────────────────────────────────────
async function getConfig(req, res) {
  try {
    const config = await getCampaignConfig();
    return res.json({ config });
  } catch (err) {
    console.error(`[${req.requestId}] \u274c admin get-config error: ${err.message}`);
    return res.status(500).json({ error: 'Could not load campaign config.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/referral/config
// Body: any subset of { active, discountPercent, commissionPercent,
// minWithdrawal, holdDays, maxCommissionPerReferral, startDate, endDate }
// All validated server-side in referralEngine.updateCampaignConfig — this
// handler just forwards the request and the resulting error, if any.
// ─────────────────────────────────────────────────────────────────────────────
async function updateConfig(req, res) {
  try {
    const result = await updateCampaignConfig(req.body);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    console.log(`[${req.requestId}] \u2699\ufe0f Campaign config updated by admin=${req.uid}`);
    return res.json({ success: true, config: result.config });
  } catch (err) {
    console.error(`[${req.requestId}] \u274c admin update-config error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not update campaign config.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/referral/analytics
// One rollup of everything the spec's "Analytics" section asked for.
// Uses Firestore's sum/count aggregation queries where possible (cheap —
// doesn't fetch documents, just a number) rather than pulling every
// document into memory to add up in JavaScript.
// ─────────────────────────────────────────────────────────────────────────────
async function getAnalytics(req, res) {
  try {
    const [
      clicksAgg,
      signupsAgg,
      firstPurchasesCountAgg,
      commissionsAgg,
      discountsAgg,
      revenueAgg,
      topReferrersSnap,
      pendingWithdrawalsSnap,
      approvedWithdrawalsSnap,
    ] = await Promise.all([
      db.collection('referral_codes').aggregate({ total: AggregateField.sum('clicks') }).get(),
      db.collection('users').aggregate({ total: AggregateField.sum('totalReferrals') }).get(),
      db.collection('referral_transactions').count().get(),
      db.collection('referral_transactions')
        .where('status', 'in', ['pending', 'completed'])
        .aggregate({ total: AggregateField.sum('commission') }).get(),
      db.collection('purchases')
        .where('discountApplied', '==', true)
        .aggregate({ total: AggregateField.sum('discountAmount') }).get(),
      db.collection('referral_transactions')
        .where('status', 'in', ['pending', 'completed'])
        .aggregate({ total: AggregateField.sum('discountedAmount') }).get(),
      db.collection('users').orderBy('lifetimeEarnings', 'desc').limit(10).get(),
      db.collection('withdrawal_requests').where('status', '==', 'pending').get(),
      db.collection('withdrawal_requests').where('status', '==', 'approved').get(),
    ]);

    const totalSignups = signupsAgg.data().total || 0;
    const totalFirstPurchases = firstPurchasesCountAgg.data().count || 0;
    const conversionRatePercent = totalSignups > 0
      ? Math.round((totalFirstPurchases / totalSignups) * 1000) / 10
      : 0;

    const topReferrers = topReferrersSnap.docs
      .map((d) => ({
        name: d.data().name || 'Unknown',
        totalReferrals: d.data().totalReferrals || 0,
        lifetimeEarnings: d.data().lifetimeEarnings || 0,
      }))
      .filter((r) => r.lifetimeEarnings > 0 || r.totalReferrals > 0);

    const sumRequested = (snap) => snap.docs.reduce((sum, d) => sum + (d.data().requestedAmount || 0), 0);

    return res.json({
      totalReferralClicks: clicksAgg.data().total || 0,
      totalSignups,
      totalFirstPurchases,
      conversionRatePercent,
      totalCommissionsPaid: commissionsAgg.data().total || 0,
      totalDiscountsGiven: discountsAgg.data().total || 0,
      referralGeneratedRevenue: revenueAgg.data().total || 0,
      topReferrers,
      pendingWithdrawals: { count: pendingWithdrawalsSnap.size, total: sumRequested(pendingWithdrawalsSnap) },
      approvedWithdrawals: { count: approvedWithdrawalsSnap.size, total: sumRequested(approvedWithdrawalsSnap) },
    });
  } catch (err) {
    console.error(`[${req.requestId}] \u274c admin analytics error: ${err.message}`);
    return res.status(500).json({ error: 'Could not load analytics right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/referral/withdrawals?status=pending
// ─────────────────────────────────────────────────────────────────────────────
async function listWithdrawals(req, res) {
  try {
    const status = (req.query?.status || 'pending').toString();
    let query = db.collection('withdrawal_requests');
    if (['pending', 'approved', 'rejected'].includes(status)) {
      query = query.where('status', '==', status);
    }
    const snap = await query.orderBy('requestedAt', 'desc').limit(100).get();

    const withdrawals = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        userId: d.userId,
        name: d.name,
        email: d.email,
        walletBalance: d.walletBalance,
        requestedAmount: d.requestedAmount,
        requestedAt: d.requestedAt ? d.requestedAt.toDate().toISOString() : null,
        status: d.status,
      };
    });

    return res.json({ withdrawals });
  } catch (err) {
    console.error(`[${req.requestId}] \u274c admin list-withdrawals error: ${err.message}`);
    return res.status(500).json({ error: 'Could not load withdrawal requests right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/referral/withdrawals/:id/approve
// Marks the request approved AND deducts the amount from the user's wallet —
// this signifies you've actually sent the money outside this system (per
// spec, automatic payouts aren't implemented). If the balance has shrunk
// below the requested amount since the request was made (e.g. a refund
// landed in between), this refuses rather than pushing the balance negative.
// ─────────────────────────────────────────────────────────────────────────────
async function approveWithdrawal(req, res) {
  const { requestId } = req;
  const withdrawalId = req.params.id;

  try {
    const result = await db.runTransaction(async (tx) => {
      const reqRef = db.collection('withdrawal_requests').doc(withdrawalId);
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists) return { error: 'Withdrawal request not found.' };
      const reqData = reqSnap.data();
      if (reqData.status !== 'pending') {
        return { error: `This request is already ${reqData.status}.` };
      }

      const userRef = db.collection('users').doc(reqData.userId);
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return { error: 'This user no longer exists.' };

      const currentBalance = userSnap.data().walletBalance || 0;
      if (currentBalance < reqData.requestedAmount) {
        return {
          error: `Current wallet balance (\u20b9${currentBalance.toFixed(2)}) is now below the requested amount (\u20b9${reqData.requestedAmount.toFixed(2)}) \u2014 probably a refund landed since the request. Reject instead, or adjust manually.`,
        };
      }

      tx.update(reqRef, { status: 'approved', processedAt: admin.firestore.FieldValue.serverTimestamp() });
      tx.update(userRef, { walletBalance: admin.firestore.FieldValue.increment(-reqData.requestedAmount) });

      queueNotification(tx, {
        uid: reqData.userId,
        type: 'withdrawal_approved',
        message: `\u2705 Your withdrawal request for \u20b9${reqData.requestedAmount.toFixed(2)} has been approved.`,
      });

      return { success: true };
    });

    if (result.error) return res.status(400).json({ success: false, error: result.error });
    console.log(`[${requestId}] \u2705 Withdrawal approved | id=${withdrawalId} admin=${req.uid}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[${requestId}] \u274c approve-withdrawal error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not approve withdrawal right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/referral/withdrawals/:id/reject
// No balance change — the money stays in their wallet since they weren't paid.
// ─────────────────────────────────────────────────────────────────────────────
async function rejectWithdrawal(req, res) {
  const { requestId } = req;
  const withdrawalId = req.params.id;
  const reason = (req.body?.reason || '').toString().slice(0, 300);

  try {
    const result = await db.runTransaction(async (tx) => {
      const reqRef = db.collection('withdrawal_requests').doc(withdrawalId);
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists) return { error: 'Withdrawal request not found.' };
      const reqData = reqSnap.data();
      if (reqData.status !== 'pending') {
        return { error: `This request is already ${reqData.status}.` };
      }

      tx.update(reqRef, {
        status: 'rejected',
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(reason ? { rejectionReason: reason } : {}),
      });

      queueNotification(tx, {
        uid: reqData.userId,
        type: 'withdrawal_rejected',
        message: reason
          ? `Your withdrawal request for \u20b9${reqData.requestedAmount.toFixed(2)} was rejected: ${reason}`
          : `Your withdrawal request for \u20b9${reqData.requestedAmount.toFixed(2)} was rejected.`,
      });

      return { success: true };
    });

    if (result.error) return res.status(400).json({ success: false, error: result.error });
    console.log(`[${requestId}] \u2716\ufe0f Withdrawal rejected | id=${withdrawalId} admin=${req.uid}`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[${requestId}] \u274c reject-withdrawal error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not reject withdrawal right now.' });
  }
}

module.exports = { getConfig, updateConfig, getAnalytics, listWithdrawals, approveWithdrawal, rejectWithdrawal };
