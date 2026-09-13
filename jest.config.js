module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/db/test/**/*.test.js'],
  globalSetup: '<rootDir>/db/test/globalSetup.js',
  globalTeardown: '<rootDir>/db/test/globalTeardown.js',
  testTimeout: 30000,
};
