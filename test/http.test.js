const test = require('node:test');
const assert = require('node:assert/strict');
const { validateVerify } = require('../src/routes/billingRoutes');
const { createPubsubAuth } = require('../src/middleware/pubsubAuth');
const { requireEntitlement } = require('../src/middleware/requireEntitlement');
const { createMemoryStore } = require('../src/services/playPurchaseStore');

function run(mw, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end() { resolve({ status: this.statusCode }); return this; } };
    Promise.resolve(mw(req, res, () => resolve({ status: 'next' })));
  });
}

test('verify validation rejects malformed product ids and tokens', async () => {
  assert.equal((await run(validateVerify, { body: { productId: 'fix_resume', purchaseToken: 'x'.repeat(40) } })).status, 400);
  assert.equal((await run(validateVerify, { body: { productId: 'fix_my_resume', purchaseToken: 'short' } })).status, 400);
  assert.equal((await run(validateVerify, { body: { productId: { $ne: 1 }, purchaseToken: 'x'.repeat(40) } })).status, 400);
  assert.equal((await run(validateVerify, { body: { productId: 'fix_my_resume', purchaseToken: 'x'.repeat(40) } })).status, 'next');
});

test('RTDN endpoint fails closed without config, rejects missing/invalid/wrong-sender tokens', async () => {
  delete process.env.PUBSUB_PUSH_AUDIENCE; delete process.env.PUBSUB_PUSH_SERVICE_ACCOUNT;
  const mw = createPubsubAuth({ verifier: async () => ({ email: 'push@p.iam.gserviceaccount.com', email_verified: true }) });
  assert.equal((await run(mw, { headers: { authorization: 'Bearer t' } })).status, 503);
  process.env.PUBSUB_PUSH_AUDIENCE = 'aud'; process.env.PUBSUB_PUSH_SERVICE_ACCOUNT = 'push@p.iam.gserviceaccount.com';
  assert.equal((await run(mw, { headers: {} })).status, 401);
  assert.equal((await run(mw, { headers: { authorization: 'Bearer t' } })).status, 'next');
  const bad = createPubsubAuth({ verifier: async () => ({ email: 'evil@x.com', email_verified: true }) });
  assert.equal((await run(bad, { headers: { authorization: 'Bearer t' } })).status, 403);
  const throws = createPubsubAuth({ verifier: async () => { throw new Error('bad sig'); } });
  assert.equal((await run(throws, { headers: { authorization: 'Bearer t' } })).status, 401);
});

test('requireEntitlement: 401 unauthenticated, 403 without entitlement, passes with it', async () => {
  const store = createMemoryStore();
  await store.recomputeEntitlements('u', 1);
  const mw = requireEntitlement('human_expert_review', { store });
  assert.equal((await run(mw, {})).status, 401);
  assert.equal((await run(mw, { uid: 'u' })).status, 403);
  store._purchases.set('h', { uid: 'u', productId: 'expert_review', status: 'active' });
  await store.recomputeEntitlements('u', 2);
  assert.equal((await run(mw, { uid: 'u' })).status, 'next');
});
