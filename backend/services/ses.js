const FROM = process.env.SES_FROM_EMAIL;

async function sendEmail({ to, subject, html, text }) {
    if (!FROM) {
        console.log(`[ses:dev] To: ${to} | Subject: ${subject}\n${text || ''}`);
        return;
    }

    const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
    const ses = new SESClient({ region: process.env.AWS_REGION || 'us-east-1' });

    await ses.send(new SendEmailCommand({
        Source: FROM,
        Destination: { ToAddresses: [to] },
        Message: {
            Subject: { Data: subject },
            Body: {
                Html: { Data: html },
                Text: { Data: text },
            },
        },
    }));
}

module.exports = { sendEmail };
