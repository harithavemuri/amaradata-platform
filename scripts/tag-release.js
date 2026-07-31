#!/usr/bin/env node
/**
 * Creates and pushes an annotated git tag matching package.json's version,
 * before a production deploy — see .claude/memory/feedback-release-tagging.md.
 *
 * Extracted into its own script (rather than inlined in package.json's deploy
 * script) for cross-shell reliability — npm's $npm_package_version /
 * %npm_package_version% substitution behaves inconsistently between bash and
 * PowerShell-invoked npm.
 *
 * Usage: node scripts/tag-release.js
 */
const { execSync } = require('child_process');
const { version }  = require('../package.json');

const tag = `v${version}`;

function run(cmd) {
    console.log(`[tag-release] ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
}

try {
    const existing = execSync(`git tag -l ${tag}`).toString().trim();
    if (existing === tag) {
        console.log(`[tag-release] Tag ${tag} already exists — skipping (bump the version in package.json for a new release).`);
        process.exit(0);
    }
    run(`git tag -a ${tag} -m "Release ${tag}"`);
    run(`git push origin ${tag}`);
    console.log(`[tag-release] Tagged and pushed ${tag}.`);
} catch (e) {
    console.error('[tag-release] Failed:', e.message);
    process.exit(1);
}
