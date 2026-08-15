import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup:     ['src/test/global-setup.js'],
        setupFiles:      ['src/test/setup.js'],
        pool:            'threads',
        maxWorkers:      1,
        fileParallelism: false,
        // nondb-readonly.test.js assumes NONDB_MODE=true (see vitest.config.nondb.js) —
        // it must not run here, where req.db.mode is 'db'.
        exclude:         ['**/node_modules/**', '**/.aws-sam/**', '**/regression_testsuite/**', '**/testing/unittests/**', '**/*.spec.js', '**/nondb-readonly.test.js'],
        coverage: {
            provider: 'v8',
            exclude: [
                '.aws-sam/**',
                'node_modules/**',
                'src/test/**',
                'scripts/**',
                'frontend/**',
            ],
            include: ['backend/**', 'server.js'],
        },
    },
});
