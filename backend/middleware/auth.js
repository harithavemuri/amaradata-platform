const jwt = require('jsonwebtoken');

const SECRET = process.env.AMRD_JWT_SECRET;
if (!SECRET) throw new Error('AMRD_JWT_SECRET environment variable is not set');

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = jwt.verify(token, SECRET);
        if (payload.type === 'refresh') return res.status(401).json({ error: 'Use access token' });
        req.staff = payload;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.staff.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        next();
    });
}

function sign(payload) {
    return jwt.sign({ ...payload, type: 'access' }, SECRET, { expiresIn: '15m' });
}

function signRefresh(payload) {
    return jwt.sign({ ...payload, type: 'refresh' }, SECRET, { expiresIn: '1h' });
}

function verifyRefresh(token) {
    const payload = jwt.verify(token, SECRET);
    if (payload.type !== 'refresh') throw new Error('Not a refresh token');
    return payload;
}

module.exports = { requireAuth, requireAdmin, sign, signRefresh, verifyRefresh };
