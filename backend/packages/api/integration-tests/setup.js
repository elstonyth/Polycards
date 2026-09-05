const { MetadataStorage } = require('@medusajs/framework/mikro-orm/core');

MetadataStorage.clear();

// The gateway switch must come from each spec, never from the developer's
// local env file — jest.config.js's loadEnv('test') falls back to it, so a
// machine pointed at the TGPay sandbox would otherwise flip every GlobePay-path
// unit test onto the TGPay branch. Specs that want TGPay set PAYMENT_GATEWAY
// themselves (they already set TGPAY_* the same way).
delete process.env.PAYMENT_GATEWAY;
