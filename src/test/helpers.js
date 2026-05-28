import jwt from 'jsonwebtoken';

const SECRET = 'test-jwt-secret-32-chars-minimum!!';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export const tokens = {
    admin:     () => jwt.sign({ id: 901, email: 'admin@t.com',  name: 'Admin',     role: 'admin',      type: 'access' }, SECRET, { expiresIn: '1h' }),
    siteAdmin: () => jwt.sign({ id: 902, email: 'sadmin@t.com', name: 'SiteAdmin', role: 'site_admin', type: 'access' }, SECRET, { expiresIn: '1h' }),
    staff:     () => jwt.sign({ id: 903, email: 'staff@t.com',  name: 'Staff',     role: 'staff',      type: 'access' }, SECRET, { expiresIn: '1h' }),
};

export const auth = (role = 'admin') => ({ Authorization: `Bearer ${tokens[role]()}` });
