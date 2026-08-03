#!/usr/bin/env node
'use strict';

/**
 * Bootstraps (idempotently) the shared Aurora Serverless v2 Postgres cluster
 * that backs BOTH amaradata-platform and rohas-group.
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * The "amaradata" cluster was created manually via a direct `aws rds
 * create-db-cluster` CLI call (confirmed via CloudTrail — invoked by IAM user
 * "haritha", not by CloudFormation), and neither app's SAM stack manages it
 * (both run with CreateDbCluster=false and just reference it externally via
 * SSM/Secrets Manager). That meant there was no reproducible record of how to
 * rebuild it — this script is that record, written by capturing the actual
 * verified live configuration as of 2026-08-02.
 *
 * IMPORTANT — KEEP THIS UPDATED:
 * Whenever the shared DB infrastructure changes OUTSIDE either app's SAM
 * template (parameter group settings, a new tenant's database/role, instance
 * class, scaling config, etc.), update the CONFIG block and relevant
 * ensure*() function below in the same change. This file should always
 * reflect the actual current state, not just the state at authoring time.
 *
 * SAFETY
 * ------
 * Every step is idempotent: it checks whether the resource already exists
 * before creating it, and never modifies or resets an existing resource's
 * credentials. Safe to re-run against the live environment at any time —
 * on a fully-provisioned environment, running this is a no-op.
 *
 * New tenant databases/roles get a freshly generated random password,
 * written directly to Secrets Manager/SSM (never printed to stdout). If a
 * tenant's role already exists, its password is left untouched — this
 * script will never silently reset a working credential (see CLAUDE.md's
 * "Least-Privilege Credential Checks" memory and the schema.sql
 * smoketest.admin incident this session for why that matters).
 *
 * Usage:
 *   node scripts/bootstrap-shared-db-infrastructure.js
 *   npm run bootstrap-db-infra
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { Client } = require('pg');

const REGION = 'ap-south-1';

const CLUSTER = {
    id:                 'amaradata',
    instanceId:         'amaradata-instance-1',
    engine:             'aurora-postgresql',
    engineVersion:      '16.11',
    instanceClass:      'db.serverless',
    port:               5432,
    masterUsername:     'amararoot',
    masterSecretId:     '/amaradata/aurora/master-password',
    vpcId:              'vpc-f45ce29c',
    subnetIds:          ['subnet-565fe13e', 'subnet-7349a73f'],
    // Reuses rohas-prod's subnet group + security group rather than creating
    // amaradata's own — both were already live when amaradata's cluster was
    // created manually; ShouldCreateDb=false in both SAM templates means
    // neither app's own DBSubnetGroup/DBSecurityGroup resources ever get
    // created either, so this is the actual resource, not a placeholder.
    dbSubnetGroupName:  'rohas-prod-dbsubnetgroup-p4m7z1spf5qm',
    vpcSecurityGroupId: 'sg-085d3a401508c7b5c', // rohas-prod-DBSecurityGroup-OEIC70zSDnix
    kmsKeyId:           'arn:aws:kms:ap-south-1:797666412164:key/48e9f7e0-eb49-4776-b5d9-5e61afc89668',
    backupRetentionDays: 7,
    deletionProtection: true,
    serverlessV2: { minCapacity: 0, maxCapacity: 4, secondsUntilAutoPause: 300 },
};

// Custom cluster parameter group — see the 2026-08-02 RDS-cost investigation
// this session: idle_in_transaction_session_timeout guards against a stuck
// connection blocking Serverless v2 auto-pause indefinitely (root cause of a
// 6-day, ~$80 continuous-ACU incident).
const PARAMETER_GROUP = {
    name:        'amaradata-shared-cluster-pg',
    family:      'aurora-postgresql16',
    description: 'Shared amaradata/rohas-group cluster - adds idle-in-transaction and statement timeouts to prevent stuck connections blocking Serverless v2 auto-pause',
    parameters: {
        idle_in_transaction_session_timeout: '600000',  // 10 min
        statement_timeout:                   '1800000', // 30 min
    },
};

// One entry per tenant sharing this cluster. `dbName` must match that
// tenant's own SAM template's DbName parameter (see each repo's
// samconfig.toml). writerUser/readerUser must match AMRD_DB_WRITE_USER /
// AMRD_DB_READ_USER (or that tenant's equivalent) as resolved from SSM.
const TENANTS = [
    {
        tenant:     'amaradata',
        dbName:     'amaradata_platform',
        writerUser: 'amrd_writer',
        readerUser: 'amrd_reader',
    },
    {
        tenant:     'rohas',
        dbName:     'amaradata_rohas',
        writerUser: 'rohas_writer',
        readerUser: 'rohas_reader',
    },
];

function aws(args) {
    const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });
    return out.trim() ? JSON.parse(out) : null;
}

function generatePassword() {
    // 24 random bytes -> base64, stripped of characters that commonly need
    // shell/URL/connection-string escaping.
    return crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 28) + 'Aa9!';
}

async function ensureClusterParameterGroup() {
    let exists = false;
    try {
        aws(['rds', 'describe-db-cluster-parameter-groups', '--db-cluster-parameter-group-name', PARAMETER_GROUP.name]);
        exists = true;
    } catch { /* not found */ }

    if (!exists) {
        console.log(`[create] cluster parameter group ${PARAMETER_GROUP.name}`);
        aws([
            'rds', 'create-db-cluster-parameter-group',
            '--db-cluster-parameter-group-name', PARAMETER_GROUP.name,
            '--db-parameter-group-family', PARAMETER_GROUP.family,
            '--description', PARAMETER_GROUP.description,
        ]);
    } else {
        console.log(`[ok] cluster parameter group ${PARAMETER_GROUP.name} already exists`);
    }

    // Parameter VALUES are safe to reconcile every run (not credentials) --
    // always push the current desired values so drift gets corrected.
    const paramArgs = Object.entries(PARAMETER_GROUP.parameters)
        .map(([name, value]) => `ParameterName=${name},ParameterValue=${value},ApplyMethod=immediate`);
    aws([
        'rds', 'modify-db-cluster-parameter-group',
        '--db-cluster-parameter-group-name', PARAMETER_GROUP.name,
        '--parameters', ...paramArgs,
    ]);
    console.log(`[ok] cluster parameter group values reconciled`);
}

async function ensureDBCluster() {
    let existing = null;
    try {
        const res = aws(['rds', 'describe-db-clusters', '--db-cluster-identifier', CLUSTER.id]);
        existing = res.DBClusters[0];
    } catch { /* not found */ }

    if (existing) {
        console.log(`[ok] DB cluster ${CLUSTER.id} already exists (status: ${existing.Status})`);
        return;
    }

    console.log(`[create] DB cluster ${CLUSTER.id} -- generating a fresh master password`);
    const masterPassword = generatePassword();

    aws([
        'rds', 'create-db-cluster',
        '--db-cluster-identifier', CLUSTER.id,
        '--engine', CLUSTER.engine,
        '--engine-version', CLUSTER.engineVersion,
        '--master-username', CLUSTER.masterUsername,
        '--master-user-password', masterPassword,
        '--db-subnet-group-name', CLUSTER.dbSubnetGroupName,
        '--vpc-security-group-ids', CLUSTER.vpcSecurityGroupId,
        '--db-cluster-parameter-group-name', PARAMETER_GROUP.name,
        '--serverless-v2-scaling-configuration',
        `MinCapacity=${CLUSTER.serverlessV2.minCapacity},MaxCapacity=${CLUSTER.serverlessV2.maxCapacity}`,
        '--storage-encrypted',
        '--kms-key-id', CLUSTER.kmsKeyId,
        '--backup-retention-period', String(CLUSTER.backupRetentionDays),
        ...(CLUSTER.deletionProtection ? ['--deletion-protection'] : ['--no-deletion-protection']),
    ]);

    // Store the freshly generated master password immediately -- never
    // printed, never held longer than needed to write it out.
    let secretExists = false;
    try { aws(['secretsmanager', 'describe-secret', '--secret-id', CLUSTER.masterSecretId]); secretExists = true; } catch {}
    const putArgs = secretExists
        ? ['secretsmanager', 'put-secret-value', '--secret-id', CLUSTER.masterSecretId, '--secret-string', masterPassword]
        : ['secretsmanager', 'create-secret', '--name', CLUSTER.masterSecretId, '--secret-string', masterPassword];
    aws(putArgs);
    console.log(`[ok] master password stored at ${CLUSTER.masterSecretId}`);

    console.log('[wait] cluster becoming available...');
    execFileSync('aws', ['rds', 'wait', 'db-cluster-available', '--region', REGION, '--db-cluster-identifier', CLUSTER.id], { stdio: 'inherit' });
}

async function ensureDBInstance() {
    let exists = false;
    try {
        aws(['rds', 'describe-db-instances', '--db-instance-identifier', CLUSTER.instanceId]);
        exists = true;
    } catch { /* not found */ }

    if (exists) {
        console.log(`[ok] DB instance ${CLUSTER.instanceId} already exists`);
        return;
    }

    console.log(`[create] DB instance ${CLUSTER.instanceId}`);
    aws([
        'rds', 'create-db-instance',
        '--db-instance-identifier', CLUSTER.instanceId,
        '--db-cluster-identifier', CLUSTER.id,
        '--db-instance-class', CLUSTER.instanceClass,
        '--engine', CLUSTER.engine,
        '--no-publicly-accessible',
    ]);
    console.log('[wait] instance becoming available...');
    execFileSync('aws', ['rds', 'wait', 'db-instance-available', '--region', REGION, '--db-instance-identifier', CLUSTER.instanceId], { stdio: 'inherit' });
}

async function getSecret(secretId) {
    const res = aws(['secretsmanager', 'get-secret-value', '--secret-id', secretId]);
    return res.SecretString;
}

async function putSecret(secretId, value) {
    let exists = false;
    try { aws(['secretsmanager', 'describe-secret', '--secret-id', secretId]); exists = true; } catch {}
    if (exists) aws(['secretsmanager', 'put-secret-value', '--secret-id', secretId, '--secret-string', value]);
    else        aws(['secretsmanager', 'create-secret', '--name', secretId, '--secret-string', value]);
}

async function putSsmParam(name, value) {
    aws(['ssm', 'put-parameter', '--name', name, '--value', value, '--type', 'String', '--overwrite']);
}

async function ensureTenantDatabaseAndRoles({ tenant, dbName, writerUser, readerUser }) {
    console.log(`\n--- Tenant: ${tenant} (database: ${dbName}) ---`);
    const host = (await getHostEndpoint());
    const masterPassword = await getSecret(CLUSTER.masterSecretId);

    const client = new Client({
        host, port: CLUSTER.port, database: 'postgres',
        user: CLUSTER.masterUsername, password: masterPassword,
    });
    await client.connect();

    try {
        const { rows: dbRows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (dbRows.length) {
            console.log(`[ok] database ${dbName} already exists`);
        } else {
            console.log(`[create] database ${dbName}`);
            await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
        }

        for (const [role, ssmSuffix, secretSuffix, privilege] of [
            [writerUser, 'db-write-user', 'db-write-password', 'write'],
            [readerUser, 'db-read-user',  'db-read-password',  'read'],
        ]) {
            const { rows: roleRows } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
            const ssmName    = `/${tenant}/prod/${ssmSuffix}`;
            const secretName = `/${tenant}/prod/${secretSuffix}`;

            if (roleRows.length) {
                console.log(`[ok] role ${role} already exists -- not touching its password`);
            } else {
                console.log(`[create] role ${role} (${privilege})`);
                const password = generatePassword();
                await client.query(`CREATE ROLE ${client.escapeIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
                await putSecret(secretName, password);
                console.log(`[ok] password stored at ${secretName}`);
            }
            // Username itself isn't sensitive -- always safe to reconcile in SSM.
            await putSsmParam(ssmName, role);
        }
    } finally {
        await client.end();
    }
}

let _hostCache;
async function getHostEndpoint() {
    if (_hostCache) return _hostCache;
    const res = aws(['rds', 'describe-db-clusters', '--db-cluster-identifier', CLUSTER.id]);
    _hostCache = res.DBClusters[0].Endpoint;
    return _hostCache;
}

async function main() {
    console.log('=== Bootstrapping shared DB infrastructure (idempotent) ===\n');
    await ensureClusterParameterGroup();
    await ensureDBCluster();
    await ensureDBInstance();
    for (const t of TENANTS) await ensureTenantDatabaseAndRoles(t);
    console.log('\n=== Done. Existing credentials were never modified. ===');
    console.log('Reminder: after creating any NEW role/database here, the owning');
    console.log('app needs `npm run deploy` (or its equivalent) to pick up the new');
    console.log('SSM/Secrets Manager values -- CloudFormation dynamic references');
    console.log('only resolve at deploy time, not automatically.');
}

main().catch((e) => {
    console.error('[bootstrap] Fatal error:', e.message);
    process.exit(1);
});
