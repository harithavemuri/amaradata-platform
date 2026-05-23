const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { Pool } = require('pg');

const SECRET = process.env.AMRD_JWT_SECRET;

function sign(payload)        { return jwt.sign({ ...payload, type: 'access'  }, SECRET, { expiresIn: '15m' }); }
function signRefresh(payload) { return jwt.sign({ ...payload, type: 'refresh' }, SECRET, { expiresIn: '1h'  }); }

exports.handler = async (event) => {
    const headers = { 'Content-Type': 'application/json' };
    try {
        const { email, password } = JSON.parse(event.body || '{}');
        if (!email || !password) return { statusCode: 400, headers, body: JSON.stringify({ error: 'email and password required' }) };

        const pool = new Pool({
            host:     process.env.AMRD_DB_HOST,
            port:     parseInt(process.env.AMRD_DB_PORT || '5432'),
            database: process.env.AMRD_DB_NAME,
            user:     process.env.AMRD_DB_WRITE_USER,
            password: process.env.AMRD_DB_WRITE_PASSWORD,
            max: 2,
            connectionTimeoutMillis: 5000,
        });

        const { rows } = await pool.query(
            'SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [email]
        );
        await pool.end();

        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash)))
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };

        const safe = { id: user.id, email: user.email, name: user.name, role: user.role };
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, token: sign(safe), refresh_token: signRefresh(safe), user: safe }),
        };
    } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
};
