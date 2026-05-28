import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup:     ['testing/global-setup.js'],
        setupFiles:      ['testing/unittests/setup.js'],
        fileParallelism: false,
        include:         ['testing/unittests/**/*.test.js'],
        coverage: {
            provider: 'v8',
            exclude: [
                '.aws-sam/**',
                'node_modules/**',
                'src/test/**',
                'scripts/**',
                'frontend/**',
                'testing/**',
            ],
            include: ['backend/**', 'server.js'],
        },
    },
});
