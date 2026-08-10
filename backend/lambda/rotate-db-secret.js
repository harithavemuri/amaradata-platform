/**
 * Generic Secrets Manager rotation Lambda for PostgreSQL DB passwords.
 *
 * One function serves every tenant/env: the secret's own name tells it which
 * database role to rotate and where to find that role's username and host, so
 * onboarding a new tenant needs no code change here.
 *
 * Implements the standard four-step rotation contract Secrets Manager invokes:
 *   createSecret → generate a new password, store it as AWSPENDING
 *   setSecret    → ALTER ROLE the database user to the AWSPENDING password
 *   testSecret   → open a real connection with AWSPENDING to prove it works
 *   finishSecret → promote AWSPENDING to AWSCURRENT
 *
 * The staged design is what makes rotation safe to retry: nothing is promoted
 * until a real login with the new password has succeeded, and a failure at any
 * step leaves AWSCURRENT untouched.
 *
 * Non-VPC by design — it needs both the Secrets Manager API and the database,
 * and a VPC-attached function has no route to the former without an interface
 * endpoint. It reaches Aurora over the same path the other non-VPC Lambdas use.
 */
const { Client } = require('pg');
const {
    SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand,
    UpdateSecretVersionStageCommand, DescribeSecretCommand,
    GetRandomPasswordCommand,
} = require('@aws-sdk/client-secrets-manager');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const sm  = new SecretsManagerClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// The credential used to ALTER other roles. Rotating this one is deliberately
// not supported here: it is the very credential this function authenticates
// with, so rotating it through this path would saw off the branch it sits on.
const MASTER_SECRET_ID = process.env.DB_MASTER_SECRET_ID || '/amaradata/aurora/master-password';
const MASTER_USER      = process.env.DB_MASTER_USER      || 'amararoot';

/**
 * Map a password secret's name to the role it controls and where that role's
 * username and host live.
 *
 * Only the three password shapes are rotatable. db-host / db-user / db-read-user
 * / db-write-user live under the same prefix but hold configuration, not
 * credentials — rotating one would overwrite a hostname or a username with a
 * random string, so they are rejected outright rather than silently skipped.
 *
 * @param {string} secretId
 * @returns {{tenant:string, env:string, userPath:string, hostPath:string}|null}
 *          null when the secret is not a rotatable DB password.
 */
function parseSecretId(secretId) {
    if (typeof secretId !== 'string') return null;

    // Accept a full ARN as well as a bare name — Secrets Manager passes the ARN.
    const name = secretId.startsWith('arn:')
        ? (secretId.split(':secret:')[1] || '').replace(/-[A-Za-z0-9]{6}$/, '')
        : secretId;

    const m = name.match(/^\/([^/]+)\/([^/]+)\/db-(read-|write-)?password$/);
    if (!m) return null;

    const [, tenant, env, roleRaw] = m;

    // The Aurora master password matches the shape but is excluded above.
    if (name === MASTER_SECRET_ID) return null;

    const role   = roleRaw || '';           // '', 'read-', or 'write-'
    const prefix = `/${tenant}/${env}`;
    return {
        tenant,
        env,
        userPath: `${prefix}/db-${role}user`,
        hostPath: `${prefix}/db-host`,
    };
}

/** True when a secret should have this rotation Lambda attached to it. */
function isRotatableDbSecret(secretId) {
    return parseSecretId(secretId) !== null;
}

/**
 * Read a config value that may live in either store: amaradata keeps usernames
 * and hosts in SSM Parameter Store, rohas keeps them in Secrets Manager. Trying
 * both is what lets one Lambda serve both without per-tenant configuration.
 */
async function readConfigValue(path) {
    try {
        const res = await ssm.send(new GetParameterCommand({ Name: path }));
        if (res.Parameter?.Value) return res.Parameter.Value.trim();
    } catch (e) {
        if (e.name !== 'ParameterNotFound') throw e;
    }
    const res = await sm.send(new GetSecretValueCommand({ SecretId: path }));
    return (res.SecretString || '').trim();
}

async function getStagedPassword(secretId, stage, token) {
    const res = await sm.send(new GetSecretValueCommand({
        SecretId: secretId, VersionStage: stage,
        ...(token && stage === 'AWSPENDING' ? { VersionId: token } : {}),
    }));
    return (res.SecretString || '').trim();
}

function connect({ host, user, password, database = 'postgres' }) {
    return new Client({
        host, port: 5432, user, password, database,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
    });
}

async function createSecret(secretId, token) {
    try {
        await getStagedPassword(secretId, 'AWSPENDING', token);
        console.log('[rotate] AWSPENDING already exists; reusing it');
        return;                                   // idempotent: retries must not regenerate
    } catch (e) {
        if (e.name !== 'ResourceNotFoundException') throw e;
    }

    // ExcludePunctuation avoids characters that need escaping in a libpq
    // connection string or a psql invocation downstream.
    const { RandomPassword } = await sm.send(new GetRandomPasswordCommand({
        PasswordLength: 32, ExcludePunctuation: true, RequireEachIncludedType: true,
    }));

    await sm.send(new PutSecretValueCommand({
        SecretId: secretId,
        ClientRequestToken: token,
        SecretString: RandomPassword,
        VersionStages: ['AWSPENDING'],
    }));
    console.log('[rotate] generated a new AWSPENDING password');
}

async function setSecret(secretId, token, ctx) {
    const pending = await getStagedPassword(secretId, 'AWSPENDING', token);
    const master  = await getStagedPassword(MASTER_SECRET_ID, 'AWSCURRENT');
    const host    = await readConfigValue(ctx.hostPath);
    const dbUser  = await readConfigValue(ctx.userPath);

    const client = connect({ host, user: MASTER_USER, password: master });
    await client.connect();
    try {
        // Parameterised values are not allowed in ALTER ROLE, so the identifier is
        // quoted and the literal escaped explicitly. dbUser comes from our own
        // SSM/Secrets Manager config and pending from GetRandomPassword, but this
        // is the one place user-derived text reaches SQL text, so both are escaped.
        const ident   = `"${dbUser.replace(/"/g, '""')}"`;
        const literal = `'${pending.replace(/'/g, "''")}'`;
        await client.query(`ALTER ROLE ${ident} WITH PASSWORD ${literal}`);
        console.log(`[rotate] applied new password to role ${dbUser}`);
    } finally {
        await client.end();
    }
}

async function testSecret(secretId, token, ctx) {
    const pending = await getStagedPassword(secretId, 'AWSPENDING', token);
    const host    = await readConfigValue(ctx.hostPath);
    const dbUser  = await readConfigValue(ctx.userPath);

    const client = connect({ host, user: dbUser, password: pending });
    await client.connect();
    try {
        await client.query('SELECT 1');
        console.log(`[rotate] verified login for ${dbUser} with the new password`);
    } finally {
        await client.end();
    }
}

async function finishSecret(secretId, token) {
    const meta = await sm.send(new DescribeSecretCommand({ SecretId: secretId }));
    const currentVersion = Object.entries(meta.VersionIdsToStages || {})
        .find(([, stages]) => stages.includes('AWSCURRENT'))?.[0];

    if (currentVersion === token) {
        console.log('[rotate] already AWSCURRENT; nothing to promote');
        return;
    }

    await sm.send(new UpdateSecretVersionStageCommand({
        SecretId: secretId,
        VersionStage: 'AWSCURRENT',
        MoveToVersionId: token,
        RemoveFromVersionId: currentVersion,
    }));
    console.log('[rotate] promoted AWSPENDING to AWSCURRENT');
}

exports.handler = async (event) => {
    const { SecretId, ClientRequestToken, Step } = event;
    console.log(`[rotate] ${Step} for ${SecretId}`);

    const ctx = parseSecretId(SecretId);
    if (!ctx) {
        // Refusing loudly matters: this is the guard that stops a misattached
        // rotation from overwriting /rohas/prod/db-host with a random password.
        throw new Error(
            `Refusing to rotate ${SecretId}: not a rotatable DB password secret ` +
            `(expected /<tenant>/<env>/db-[read-|write-]password, and never the Aurora master password)`
        );
    }

    switch (Step) {
        case 'createSecret': await createSecret(SecretId, ClientRequestToken); break;
        case 'setSecret':    await setSecret(SecretId, ClientRequestToken, ctx); break;
        case 'testSecret':   await testSecret(SecretId, ClientRequestToken, ctx); break;
        case 'finishSecret': await finishSecret(SecretId, ClientRequestToken); break;
        default: throw new Error(`Unknown rotation step: ${Step}`);
    }
    return { statusCode: 200, step: Step };
};

module.exports.parseSecretId       = parseSecretId;
module.exports.isRotatableDbSecret = isRotatableDbSecret;
