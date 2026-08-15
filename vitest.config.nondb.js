import { defineConfig } from 'vitest/config';

// NonDB mode is read-only (see project-nondb-read-only.md), so the old full
// dual-mode run of every src/test/*.test.js file no longer applies here — those
// assume every write succeeds in both modes. Only src/test/nondb-readonly.test.js
// runs under this config now; full CRUD-workflow coverage stays DB-mode-only
// (the default vitest.config.js).
export default defineConfig({
    test: {
        globalSetup:     ['src/test/global-setup.nondb.js'],
        setupFiles:      ['src/test/setup.nondb.js'],
        pool:            'threads',
        maxWorkers:      1,
        fileParallelism: false,
        include:         ['src/test/nondb-readonly.test.js'],
    },
});
