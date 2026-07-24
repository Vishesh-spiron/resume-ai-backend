// ─────────────────────────────────────────────────────────────────────────────
// src/services/notificationService.js
// Phase 4 — bridges async, server-side referral events (a referred user
// signing up while the referrer's app is closed, for instance) to the app's
// existing snackbar-based notification pattern.
//
// The app has no notification center or bell icon — just inline
// ScaffoldMessenger snackbars shown while the user is looking at a screen.
// Since these events happen when the recipient isn't necessarily in the
// app, they're persisted here as small "unread" records; the Earn & Refer
// screen fetches and shows them as snackbars the next time it opens, then
// marks them read. No new UI system, just a queue feeding the one that
// already exists.
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db } = require('../config/firebaseAdmin');

// Call this FROM WITHIN an existing Firestore transaction (tx.set, not
// awaited separately) so a notification is only ever written if the event
// it describes actually committed. See referralController.js / referralEngine.js.
function queueNotification(tx, { uid, type, message }) {
  const ref = db.collection('notifications').doc();
  tx.set(ref, {
    uid,
    type, // 'referral_signup' | 'commission_credited' | 'withdrawal_submitted'
    message,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function getUnreadNotifications(uid) {
  const snap = await db.collection('notifications')
    .where('uid', '==', uid)
    .where('read', '==', false)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  return snap.docs.map((doc) => ({
    id: doc.id,
    type: doc.data().type,
    message: doc.data().message,
    createdAt: doc.data().createdAt ? doc.data().createdAt.toDate().toISOString() : null,
  }));
}

async function markAllNotificationsRead(uid) {
  const snap = await db.collection('notifications')
    .where('uid', '==', uid)
    .where('read', '==', false)
    .get();

  if (snap.empty) return { updated: 0 };

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.update(doc.ref, { read: true }));
  await batch.commit();
  return { updated: snap.size };
}

module.exports = { queueNotification, getUnreadNotifications, markAllNotificationsRead };
