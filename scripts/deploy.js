#!/usr/bin/env node
/**
 * Deploy runner — replaces the long `a && b && c` npm-script chain.
 *
 * The chain it replaces invoked npm from inside npm for each test phase, and on
 * this machine that nesting intermittently died with no output at all: exit 1,
 * empty stderr, nothing from the underlying test runner. It happened three times
 * in a row at the same boundary while every phase passed cleanly on its own, and
 * the sibling rohas-group repo hit the identical failure (see its commit
 * 0d12fa2). Each phase here spawns its real command directly — npx/node/sam/aws —
 * so there is no intermediate npm process to lose.
 *
 * The test gate is not optional and there is deliberately no flag to skip it:
 * every phase must pass before anything is built or deployed.
 *
 *   node scripts/deploy.js [--dry-run]
 *
 *   --dry-run   print the phase plan and exit without running anything
 */
const { spawnSync, execFileSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');

const S3_BUCKET   = process.env.DEPLOY_S3_BUCKET   || 'amrd-platform-amaradata-prod-797666412164';
const CF_DIST_ID  = process.env.DEPLOY_CF_DIST_ID  || 'EVRE22H489D0P';

const REGRESSION_CFG = 'testing/regression_testsuite/playwright.config.js';
const RELEASE_CFG    = 'testing/release-tracking/playwright.config.release-checks.js';

/** Ports the Playwright suites bind. A killed run can leave one held, which
 *  fails the next phase with "address already used" — clear them first. */
const TEST_PORTS = [9001, 9002];

const PHASES = [
    { name: 'Unit + integration — DB mode',    cmd: 'npx', args: ['vitest', 'run'] },
    { name: 'Unit + integration — NonDB mode', cmd: 'npx', args: ['vitest', 'run', '--config', 'vitest.config.nondb.js'] },
    { name: 'Unittests',                       cmd: 'npx', args: ['vitest', 'run', '--config', 'testing/unittests/vitest.config.js'] },

    // DB mode before NonDB, always — standing rule, never reorder.
    { name: 'Regression — DB mode',    cmd: 'npx', args: ['playwright', 'test', '--config', REGRESSION_CFG], env: { REGRESSION_DB: '1' }, freePorts: true },
    { name: 'Regression — NonDB mode', cmd: 'npx', args: ['playwright', 'test', '--config', REGRESSION_CFG], freePorts: true },
    { name: 'Release-tracking checks', cmd: 'npx', args: ['playwright', 'test', '--config', RELEASE_CFG], freePorts: true },

    { name: 'Tag release',      cmd: 'node', args: ['scripts/tag-release.js'] },
    { name: 'SAM build',        cmd: 'sam',  args: ['build'] },
    { name: 'SAM deploy',       cmd: 'sam',  args: ['deploy', '--no-confirm-changeset'] },
    { name: 'DB migrate',       cmd: 'node', args: ['scripts/db-migrate.js'] },
    { name: 'Attach rotation',  cmd: 'node', args: ['scripts/attach-secret-rotation.js'] },
    { name: 'Sync frontend',    cmd: 'aws',  args: ['s3', 'sync', 'frontend/', `s3://${S3_BUCKET}/`, '--delete'] },
    { name: 'Invalidate CDN',   cmd: 'aws',  args: ['cloudfront', 'create-invalidation', '--distribution-id', CF_DIST_ID, '--paths', '/*'] },
    { name: 'Post-deploy smoke', cmd: 'node', args: ['-r', 'dotenv/config', 'scripts/smoke-lifecycle.js'] },
];

/** Index of the first phase that touches anything outside this machine. */
const FIRST_DEPLOYING_PHASE = PHASES.findIndex(p => p.name === 'SAM deploy');

function freeTestPorts() {
    for (const port of TEST_PORTS) {
        try {
            const out = execFileSync('powershell', ['-NoProfile', '-Command',
                `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue |` +
                ` Select-Object -ExpandProperty OwningProcess -Unique`,
            ], { encoding: 'utf8' }).trim();

            for (const pid of out.split(/\s+/).filter(Boolean)) {
                execFileSync('powershell', ['-NoProfile', '-Command',
                    `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
                console.log(`  (freed port ${port} — stopped leftover pid ${pid})`);
            }
        } catch {
            // Nothing listening, or the platform lacks Get-NetTCPConnection. Either
            // way this is best-effort cleanup, never a reason to stop the deploy.
        }
    }
}

function runPhase(phase, index) {
    const label = `[${index + 1}/${PHASES.length}] ${phase.name}`;
    console.log(`\n${'─'.repeat(72)}\n${label}\n${'─'.repeat(72)}`);

    if (phase.freePorts) freeTestPorts();

    const started = Date.now();
    const res = spawnSync(phase.cmd, phase.args, {
        stdio: 'inherit',
        shell: process.platform === 'win32',   // npx/sam/aws are .cmd shims on Windows
        env: { ...process.env, ...(phase.env || {}) },
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    if (res.error) {
        console.error(`\n✗ ${phase.name} could not start: ${res.error.message}`);
        return false;
    }
    if (res.status !== 0) {
        // The empty-output case is the flake this script exists to expose rather
        // than silently inherit — say so explicitly instead of just "exit 1".
        console.error(`\n✗ ${phase.name} failed after ${secs}s (exit ${res.status})`);
        console.error(`  Re-run this phase alone to inspect it:`);
        console.error(`    ${phase.cmd} ${phase.args.join(' ')}`);
        return false;
    }

    console.log(`\n✓ ${phase.name} (${secs}s)`);
    return true;
}

function main() {
    if (DRY_RUN) {
        console.log('\nDeploy plan (dry run — nothing will be executed):\n');
        PHASES.forEach((p, i) => {
            const marker = i === FIRST_DEPLOYING_PHASE ? '  ← first phase that changes production' : '';
            console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(30)} ${p.cmd} ${p.args.join(' ')}${marker}`);
        });
        console.log('');
        return 0;
    }

    const started = Date.now();
    for (let i = 0; i < PHASES.length; i++) {
        if (!runPhase(PHASES[i], i)) {
            const reached = i >= FIRST_DEPLOYING_PHASE;
            console.error(`\n${'═'.repeat(72)}`);
            console.error(`DEPLOY ABORTED at phase ${i + 1}: ${PHASES[i].name}`);
            console.error(reached
                ? '  NOTE: this failed at or after "SAM deploy" — production may be partially updated.'
                : '  Nothing was deployed: this failed before "SAM deploy".');
            console.error(`${'═'.repeat(72)}\n`);
            return 1;
        }
    }

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`DEPLOY COMPLETE — all ${PHASES.length} phases passed in ${((Date.now() - started) / 60000).toFixed(1)} min`);
    console.log(`${'═'.repeat(72)}\n`);
    return 0;
}

if (require.main === module) process.exit(main());
