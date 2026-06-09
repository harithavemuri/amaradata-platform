#!/usr/bin/env node
'use strict';
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const FUNCTION   = 'amaradata-prod-db-migrate';
const REGION     = 'ap-south-1';
const MAX_TRIES  = 3;
const RETRY_WAIT = 30_000; // Aurora can take up to ~30 s to wake from pause

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function invokeMigrate(client) {
    const res = await client.send(new InvokeCommand({
        FunctionName:   FUNCTION,
        InvocationType: 'RequestResponse',
        Payload:        Buffer.from('{}'),
    }));

    if (res.FunctionError) {
        const body = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString()) : {};
        const msg  = body?.errorMessage || JSON.stringify(body);
        // Aurora cold-start timeout — caller will retry
        if (msg.includes('connection timeout') || msg.includes('Connection terminated')) {
            throw Object.assign(new Error(msg), { retryable: true });
        }
        console.error('[deploy] Lambda error:', res.FunctionError, body);
        process.exit(1);
    }

    return JSON.parse(Buffer.from(res.Payload).toString());
}

async function main() {
    const client = new LambdaClient({ region: REGION });

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        console.log(`[deploy] Invoking ${FUNCTION} (attempt ${attempt}/${MAX_TRIES})...`);
        try {
            const payload = await invokeMigrate(client);
            if (!payload.success) {
                console.error('[deploy] Migration failed:', payload);
                process.exit(1);
            }
            console.log('[deploy] Migration complete:', payload.message);
            return;
        } catch (err) {
            if (err.retryable && attempt < MAX_TRIES) {
                console.warn(`[deploy] Connection timeout (Aurora may be waking up) — retrying in ${RETRY_WAIT / 1000}s...`);
                await sleep(RETRY_WAIT);
            } else {
                console.error('[deploy] Unexpected error:', err.message);
                process.exit(1);
            }
        }
    }
}

main();
