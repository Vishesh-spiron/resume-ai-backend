const { createMemoryStore } = require('../src/services/playPurchaseStore');
const { createPlayBillingService } = require('../src/services/playBillingService');

const PKG = 'com.example.resumeart';
const TOKEN = (n = 1) => `token-${n}-`.padEnd(40, 'x');

function purchaseResponse(overrides = {}) {
  return {
    orderId: 'GPA.1234',
    obfuscatedExternalAccountId: 'user1',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    purchaseStateContext: { purchaseState: 'PURCHASED' },
    productLineItem: [{ productId: 'fix_my_resume' }],
    ...overrides,
  };
}

// Mocked Google client. `responses[token]` is a response object or an Error.
function makeGoogle(responses = {}) {
  const calls = { get: [], ack: [] };
  const publisher = {
    purchases: {
      productsv2: {
        getproductpurchasev2: async ({ packageName, token }) => {
          calls.get.push({ packageName, token });
          const r = responses[token];
          if (r instanceof Error) throw r;
          if (!r) { const e = new Error('not found'); e.code = 404; throw e; }
          return { data: r };
        },
      },
      products: {
        acknowledge: async (args) => {
          calls.ack.push(args);
          if (responses.__ackFails) { const e = new Error('boom'); e.code = 500; throw e; }
          return {};
        },
      },
      voidedpurchases: {
        list: async () => ({ data: { voidedPurchases: responses.__voided || [] } }),
      },
    },
  };
  return { publisher, calls, responses };
}

function setup(responses, opts = {}) {
  const google = makeGoogle(responses);
  const store = createMemoryStore();
  const clock = { t: 1_000_000 };
  const hookCalls = { recorded: [], voided: [] };
  const service = createPlayBillingService({
    store,
    getPublisher: () => google.publisher,
    packageName: PKG,
    now: () => clock.t,
    logger: { info() {}, warn() {}, error() {} },
    hooks: {
      onPurchaseRecorded: async (a) => { hookCalls.recorded.push(a); },
      onPurchaseVoided: async (a) => { hookCalls.voided.push(a); },
    },
    ...opts,
  });
  return { service, store, google, clock, hookCalls };
}

const googleErr = (code) => Object.assign(new Error(`google ${code}`), { code });

module.exports = { setup, TOKEN, PKG, purchaseResponse, googleErr };
