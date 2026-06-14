import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup:     ['src/test/global-setup.nondb.js'],
        setupFiles:      ['src/test/setup.nondb.js'],
        pool:            'threads',
        maxWorkers:      1,
        fileParallelism: false,
        exclude:         ['**/node_modules/**', '**/.aws-sam/**', '**/regression_testsuite/**', '**/testing/unittests/**', '**/*.spec.js'],
    },
});
