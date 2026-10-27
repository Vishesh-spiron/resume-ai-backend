// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/pubsubAuth.js
// Authenticates Google Pub/Sub PUSH deliveries (Play RTDN). Pub/Sub signs each
// push with an OIDC token for the push subscription's service account.
// We verify: Google signature, audience, and the service-account email.
// Without PUBSUB_PUSH_AUDIENCE + PUBSUB_PUSH_SERVICE_ACCOUNT the endpoint
// refuses every request (fails closed) — it can never be used to grant or
// revoke anything anonymously.
// ─────────────────────────────────────────────────────────────────────────────
const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client();

function createPubsubAuth({ verifier } = {}) {
  const verify =
    verifier ||
    (async (token, audience) => {
      const ticket = await client.verifyIdToken({ idToken: token, audience });
      return ticket.getPayload();
    });

  return async function pubsubAuth(req, res, next) {
    const audience = process.env.PUBSUB_PUSH_AUDIENCE;
    const expectedEmail = process.env.PUBSUB_PUSH_SERVICE_ACCOUNT;
    if (!audience || !expectedEmail) {
      return res.status(503).json({ error: 'RTDN endpoint is not configured.' });
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token.' });
    try {
      const payload = await verify(token, audience);
      if (!payload || payload.email !== expectedEmail || payload.email_verified !== true) {
        return res.status(403).json({ error: 'Unexpected sender.' });
      }
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token.' });
    }
  };
}

module.exports = { createPubsubAuth };
