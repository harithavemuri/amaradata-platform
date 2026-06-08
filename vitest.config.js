import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup:     ['src/test/global-setup.js'],
        setupFiles:      ['src/test/setup.js'],
        fileParallelism: false,
        pool:            'forks',
        poolOptions:     { forks: { singleFork: true } },
        exclude:         ['**/node_modules/**', '**/.aws-sam/**', '**/regression_testsuite/**', '**/*.spec.js'],
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
