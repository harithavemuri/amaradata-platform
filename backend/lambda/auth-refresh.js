const jwt = require('jsonwebtoken');

const SECRET = process.env.AMRD_JWT_SECRET;

function sign(payload)        { return jwt.sign({ ...payload, type: 'access'  }, SECRET, { expiresIn: '15m' }); }
function signRefresh(payload) { return jwt.sign({ ...payload, type: 'refresh' }, SECRET, { expiresIn: '1h'  }); }

exports.handler = async (event) => {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const { refresh_token } = JSON.parse(event.body || '{}');
        if (!refresh_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'refresh_token required' }) };

        const payload = jwt.verify(refresh_token, SECRET);
        if (payload.type !== 'refresh') return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not a refresh token' }) };

        const safe = { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, token: sign(safe), refresh_token: signRefresh(safe) }),
        };
    } catch {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired refresh token' }) };
    }
};
