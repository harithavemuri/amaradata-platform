#!/usr/bin/env node
/**
 * Attach the generic DB-password rotation Lambda to every eligible DB secret in
 * this AWS account. Runs after each amaradata deploy, so a newly onboarded
 * tenant's secrets become rotatable without anyone remembering a manual step.
 *
 *   node scripts/attach-secret-rotation.js [--dry-run] [--region <r>]
 *
 * Two safety properties matter more than anything else here:
 *
 *  1. Eligibility is decided by the rotation Lambda's own parseSecretId(), the
 *     same function the handler enforces at runtime. Secrets like
 *     /rohas/prod/db-host and /rohas/prod/db-user sit under the same prefix but
 *     hold configuration — attaching password rotation to one would overwrite a
 *     hostname with random text.
 *
 *  2. RotateImmediatelyOnUpdate is false. Attaching rotation must never *perform*
 *     a rotation: AWS's default is to rotate the moment rotation is configured,
 *     which would change a live password with no warning. Rotation here is
 *     on-demand only — `aws secretsmanager rotate-secret --secret-id <id>`.
 *
 * The schedule is set far out (365 days) rather than omitted because Secrets
 * Manager requires rotation rules when a rotation Lambda is attached; the intent
 * is manual rotation, not an annual one.
 */
const { execFileSync } = require('child_process');
const { isRotatableDbSecret } = require('../backend/lambda/rotate-db-secret.js');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const REGION   = args[args.indexOf('--region') + 1] && args.includes('--region')
    ? args[args.indexOf('--region') + 1]
    : (process.env.AWS_REGION || 'ap-south-1');
const TENANT   = process.env.TENANT || 'amaradata';
const ENV      = process.env.ENV    || 'prod';
const FN_NAME  = process.env.ROTATION_FN_NAME || `${TENANT}-${ENV}-rotate-db-secret`;

function aws(cmdArgs) {
    return execFileSync('aws', [...cmdArgs, '--region', REGION, '--output', 'json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
    });
}

function main() {
    console.log(`\n── Attaching DB-secret rotation (${REGION}) ──────────────────`);

    let fnArn;
    try {
        fnArn = JSON.parse(aws(['lambda', 'get-function-configuration',
            '--function-name', FN_NAME, '--query', 'FunctionArn'])).replace(/^"|"$/g, '');
    } catch (e) {
        // Before the first deploy that creates it, the function does not exist.
        // Not fatal — the next deploy will attach rotation.
        console.error(`  ! rotation Lambda "${FN_NAME}" not found — skipping attach.`);
        console.error(`    (expected on the very first deploy; it is created by template.yaml)`);
        return 0;
    }

    const secrets = JSON.parse(aws(['secretsmanager', 'list-secrets',
        '--max-results', '100',
        '--query', 'SecretList[].{Name:Name,RotationEnabled:RotationEnabled,Arn:RotationLambdaARN}']));

    const eligible = secrets.filter(s => isRotatableDbSecret(s.Name));
    const skipped  = secrets.filter(s => !isRotatableDbSecret(s.Name));

    console.log(`  Found ${secrets.length} secret(s): ${eligible.length} rotatable, ${skipped.length} skipped.`);

    let attached = 0, alreadyOk = 0, failed = 0;
    for (const s of eligible) {
        if (s.RotationEnabled && s.Arn === fnArn) {
            console.log(`  = ${s.Name} (already attached)`);
            alreadyOk++;
            continue;
        }
        if (DRY_RUN) {
            console.log(`  ~ ${s.Name} (dry run — would attach)`);
            attached++;
            continue;
        }
        try {
            aws(['secretsmanager', 'rotate-secret',
                '--secret-id', s.Name,
                '--rotation-lambda-arn', fnArn,
                '--rotation-rules', 'ScheduleExpression=rate(365 days)',
                '--no-rotate-immediately']);
            console.log(`  + ${s.Name}`);
            attached++;
        } catch (e) {
            // Keep going: one tenant's misconfigured secret must not block the rest.
            console.error(`  x ${s.Name}: ${(e.stderr || e.message).toString().trim().split('\n').pop()}`);
            failed++;
        }
    }

    console.log(`\n  Attached ${attached}, already configured ${alreadyOk}, failed ${failed}.`);
    console.log(`  Rotate on demand:  aws secretsmanager rotate-secret --secret-id <name> --region ${REGION}\n`);

    // Non-fatal by design — a rotation-attach problem should surface loudly but
    // must not fail a deploy whose application changes are already live.
    if (failed) console.error('  ! Some secrets could not be configured (see above).');
    return 0;
}

if (require.main === module) process.exit(main());
