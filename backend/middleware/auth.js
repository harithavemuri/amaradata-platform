const jwt = require('jsonwebtoken');

const SECRET = process.env.AMRD_JWT_SECRET || 'dev_secret_change_me';

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        req.staff = jwt.verify(token, SECRET);
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
    return jwt.sign(payload, SECRET, { expiresIn: '8h' });
}

module.exports = { requireAuth, requireAdmin, sign };
