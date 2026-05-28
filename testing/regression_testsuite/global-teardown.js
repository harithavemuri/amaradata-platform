const { rmSync } = require('fs');
const { resolve } = require('path');

module.exports = async function globalTeardown() {
    rmSync(resolve(__dirname, '..', 'playwright-testdata'), { recursive: true, force: true });
    console.log('[playwright:teardown] playwright-testdata directory removed');
};
