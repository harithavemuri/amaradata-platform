#!/usr/bin/env node
'use strict';
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const FUNCTION = 'amaradata-prod-db-migrate';
const REGION   = 'ap-south-1';

async function main() {
    const client = new LambdaClient({ region: REGION });
    console.log(`[deploy] Invoking ${FUNCTION}...`);

    const res = await client.send(new InvokeCommand({
        FunctionName:   FUNCTION,
        InvocationType: 'RequestResponse',
        Payload:        Buffer.from('{}'),
    }));

    if (res.FunctionError) {
        const body = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString()) : {};
        console.error('[deploy] Lambda error:', res.FunctionError, body);
        process.exit(1);
    }

    const payload = JSON.parse(Buffer.from(res.Payload).toString());
    if (!payload.success) {
        console.error('[deploy] Migration failed:', payload);
        process.exit(1);
    }
    console.log('[deploy] Migration complete:', payload.message);
}

main().catch(e => { console.error('[deploy] Unexpected error:', e.message); process.exit(1); });
