const { loadEnv } = require('@medusajs/utils');
loadEnv('test', process.cwd());

module.exports = {
  transform: {
    '^.+\\.[jt]s$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
        },
      },
    ],
  },
  testEnvironment: 'node',
  // Node16/NodeNext ESM requires explicit `.js` extensions on relative imports
  // (tsc rule TS2835), but @swc/jest resolves against the on-disk `.ts` source.
  // Strip a trailing `.js` from relative specifiers so both agree. No-op for the
  // existing suites — only the deferred draw-prize import (service.ts) uses one.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleFileExtensions: ['js', 'ts', 'json'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.medusa/'],
  setupFiles: ['./integration-tests/setup.js'],
};

if (process.env.TEST_TYPE === 'integration:http') {
  module.exports.testMatch = ['**/integration-tests/http/*.spec.[jt]s'];
} else if (process.env.TEST_TYPE === 'integration:modules') {
  module.exports.testMatch = ['**/src/modules/*/__tests__/**/*.[jt]s'];
  // The unit tier owns *.unit.spec.* — running them again here under the
  // DB-backed --runInBand runner adds minutes and no coverage.
  // '/node_modules/' listed explicitly: setting testPathIgnorePatterns
  // REPLACES jest's default, it does not merge.
  module.exports.testPathIgnorePatterns = [
    '/node_modules/',
    '\\.unit\\.spec\\.[jt]s$',
  ];
} else if (process.env.TEST_TYPE === 'unit') {
  module.exports.testMatch = ['**/src/**/__tests__/**/*.unit.spec.[jt]s'];
}
