const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const db       = require('../db');
const { sign } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    try {
        const { rows } = await db.query(
            'SELECT * FROM amr_users WHERE email = $1 AND is_active = true', [email]
        );
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        await db.query('UPDATE amr_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
        const token = sign({ id: user.id, email: user.email, name: user.name, role: user.role });
        res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/create-user  (first-time setup / admin only — no auth required for initial seed)
router.post('/create-user', async (req, res) => {
    const { email, password, name, role = 'staff', setup_key } = req.body;
    if (setup_key !== process.env.AMRD_JWT_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try {
        const hash = await bcrypt.hash(password, 12);
        const { rows } = await db.query(
            'INSERT INTO amr_users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
            [email, name, role, hash]
        );
        res.status(201).json({ success: true, data: rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
