const { MetadataStorage } = require('@medusajs/framework/mikro-orm/core');

MetadataStorage.clear();

// The gateway switch must come from each spec, never from the developer's
// local env file — jest.config.js's loadEnv('test') falls back to it. Specs
// that need a gateway set PAYMENT_GATEWAY and the TGPAY_* values themselves.
delete process.env.PAYMENT_GATEWAY;
// Same trap for the other per-call operator levers: a developer's local
// value (e.g. cooldown 0 for sandbox testing) must not rewrite the defaults
// these specs assert. Specs that need a value set it themselves.
delete process.env.PAYOUT_DESTINATION_COOLDOWN_HOURS;
delete process.env.PAYMENT_CALLBACK_BASE;
