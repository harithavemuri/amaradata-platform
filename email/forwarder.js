const { S3Client, GetObjectCommand }       = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand }  = require('@aws-sdk/client-ses');

const s3  = new S3Client({ region: process.env.AWS_REGION });
const ses = new SESClient({ region: process.env.AWS_REGION });

const FORWARD_TO = process.env.FORWARD_TO; // rajvemuri25@gmail.com
const FROM_EMAIL = process.env.FROM_EMAIL; // rajas@amaradata.com
const BUCKET     = process.env.BUCKET;

// Strip headers that cause DKIM conflicts or mail loops
const STRIP = new Set([
    'dkim-signature', 'x-google-dkim-signature',
    'domainkey-signature', 'return-path', 'sender',
]);

async function toBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

exports.handler = async (event) => {
    const record    = event.Records[0].ses;
    const messageId = record.mail.messageId;
    const origFrom  = (record.mail.commonHeaders.from  || [])[0] || '';
    const origTo    = (record.mail.commonHeaders.to    || [])[0] || '';

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `emails/${messageId}` }));
    const raw = (await toBuffer(obj.Body)).toString('utf8');

    // Split headers from body at the first blank line
    const sep       = raw.indexOf('\r\n\r\n');
    const headerRaw = sep >= 0 ? raw.slice(0, sep)      : raw;
    const body      = sep >= 0 ? raw.slice(sep + 4)     : '';

    // Unfold and collect header lines
    const rawHeaders = [];
    for (const line of headerRaw.split('\r\n')) {
        if (/^\s/.test(line) && rawHeaders.length) {
            rawHeaders[rawHeaders.length - 1] += '\r\n' + line;
        } else {
            rawHeaders.push(line);
        }
    }

    const out = [];
    for (const h of rawHeaders) {
        const name = h.split(':')[0].toLowerCase().trim();
        if (STRIP.has(name)) continue;
        if (name === 'from') {
            // Rewrite From to our verified sender; preserve original in Reply-To
            out.push(`From: ${FROM_EMAIL}`);
            if (origFrom) out.push(`Reply-To: ${origFrom}`);
            // Tell Gmail which address this was originally for → auto-selects Send-mail-as
            out.push(`X-Original-To: ${origTo || FROM_EMAIL}`);
            continue;
        }
        if (name === 'to') {
            out.push(`To: ${FORWARD_TO}`);
            out.push(`Delivered-To: ${FROM_EMAIL}`);
            continue;
        }
        if (name === 'reply-to') continue; // replaced above
        out.push(h);
    }

    const newRaw = out.join('\r\n') + '\r\n\r\n' + body;

    await ses.send(new SendRawEmailCommand({
        Source:       FROM_EMAIL,
        Destinations: [FORWARD_TO],
        RawMessage:   { Data: Buffer.from(newRaw) },
    }));

    console.log(`[forwarder] ${messageId} | from=${origFrom} → ${FORWARD_TO}`);
};
