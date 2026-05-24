(function () {
    const API = '';  // same-origin

    /* ── Auth helpers ──────────────────────────────────────────────── */
    function getToken()        { return localStorage.getItem('amrd_token'); }
    function getRefreshToken() { return localStorage.getItem('amrd_refresh_token'); }
    function getStaff()        { try { return JSON.parse(localStorage.getItem('amrd_staff') || 'null'); } catch { return null; } }
    function isLoggedIn()      { return !!getToken(); }

    function _clearSession() {
        localStorage.removeItem('amrd_token');
        localStorage.removeItem('amrd_refresh_token');
        localStorage.removeItem('amrd_staff');
    }

    function requireLogin() {
        if (!isLoggedIn() && location.pathname !== '/login') {
            location.href = '/login';
        }
    }

    function logout() {
        fetch(`${API}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json;v=1' },
        }).catch(() => {});
        _clearSession();
        location.href = '/login';
    }

    async function login(email, password) {
        const res  = await fetch(`${API}/api/auth/login`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json;v=1' },
            body:    JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        localStorage.setItem('amrd_token',         data.token);
        localStorage.setItem('amrd_refresh_token', data.refresh_token);
        localStorage.setItem('amrd_staff',         JSON.stringify(data.user));
        return data.user;
    }

    /* ── Token refresh ─────────────────────────────────────────────── */
    let _refreshing = null;

    async function _refreshToken() {
        if (_refreshing) return _refreshing;
        _refreshing = (async () => {
            const refresh_token = getRefreshToken();
            if (!refresh_token) throw new Error('No refresh token');
            const res  = await fetch(`${API}/api/auth/refresh`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json;v=1' },
                body:    JSON.stringify({ refresh_token }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error('Refresh failed');
            localStorage.setItem('amrd_token',         data.token);
            localStorage.setItem('amrd_refresh_token', data.refresh_token);
        })().finally(() => { _refreshing = null; });
        return _refreshing;
    }

    /* ── API fetch helper ──────────────────────────────────────────── */
    async function apiFetch(path, opts = {}, _retry = true) {
        const headers = {
            'Content-Type':   'application/json',
            'Accept':         'application/json;v=1',
            ...opts.headers,
        };
        const token = getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res  = await fetch(`${API}${path}`, { ...opts, headers });
        if (res.status === 401 && _retry) {
            try {
                await _refreshToken();
                return apiFetch(path, opts, false);
            } catch {
                logout();
                return;
            }
        }
        if (res.status === 401) { logout(); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        return data;
    }

    /* ── GraphQL fetch helper ─────────────────────────────────────── */
    async function gqlFetch(query, variables = {}) {
        const data = await apiFetch('/graphql', {
            method: 'POST',
            body:   JSON.stringify({ query, variables }),
        });
        if (data?.errors?.length) throw new Error(data.errors[0].message);
        return data?.data;
    }

    /* ── Session timeout (15 min inactivity) ──────────────────────── */
    function _startSessionTimeout() {
        const TIMEOUT = 15 * 60 * 1000;
        let timer;
        const reset = () => {
            clearTimeout(timer);
            timer = setTimeout(() => logout(), TIMEOUT);
        };
        ['mousemove','keydown','click','scroll','touchstart'].forEach(
            e => document.addEventListener(e, reset, { passive: true })
        );
        reset();
    }

    /* ── Sidebar ───────────────────────────────────────────────────── */
    const NAV = [
        { href: '/dashboard',    icon: 'home',    label: 'Dashboard' },
        { href: '/tenants',      icon: 'tenants', label: 'Tenants' },
        { href: '/invoices',     icon: 'invoice', label: 'Invoices' },
        { href: '/enhancements', icon: 'enhance', label: 'Enhancements' },
        { href: '/metrics',      icon: 'metrics', label: 'Billing Metrics' },
    ];

    const ADMIN_NAV = [
        { href: '/users',       icon: 'users',  label: 'Users' },
        { href: '/user-groups', icon: 'groups', label: 'User Groups' },
    ];

    const ICONS = {
        home:    `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>`,
        tenants: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>`,
        invoice: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>`,
        enhance: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>`,
        metrics: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>`,
        users:   `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/>`,
        groups:  `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>`,
    };

    function _icon(k) {
        return `<svg style="width:18px;height:18px;margin-right:10px;flex-shrink:0" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICONS[k]}</svg>`;
    }

    function _injectStyles() {
        if (document.getElementById('amrd-styles')) return;
        const s = document.createElement('style');
        s.id = 'amrd-styles';
        s.textContent = `
*{box-sizing:border-box;}
body{margin:0;font-family:'Inter',Arial,sans-serif;background:#f1f5f9;display:flex;min-height:100vh;flex-direction:column;}
.amrd-wrap{display:flex;flex:1;min-height:0;}
.amrd-sidebar{width:240px;flex-shrink:0;background:#112240;display:flex;flex-direction:column;
 height:100vh;position:sticky;top:0;overflow-y:auto;}
.amrd-logo{padding:20px 20px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:10px;text-decoration:none;}
.amrd-logo:hover{opacity:.85;}
.amrd-logo-icon{width:32px;height:32px;flex-shrink:0;}
.amrd-logo-text{display:flex;flex-direction:column;}
.amrd-logo-title{color:#fff;font-size:18px;font-weight:700;letter-spacing:.5px;}
.amrd-logo-sub{color:#64748b;font-size:11px;margin-top:2px;}
.amrd-nav{flex:1;padding:12px 0;}
.amrd-nav a{display:flex;align-items:center;padding:10px 18px;color:#94a3b8;text-decoration:none;
 font-size:13px;border-left:3px solid transparent;transition:all .15s;}
.amrd-nav a:hover{background:rgba(255,255,255,.05);color:#e2e8f0;border-left-color:#0D9488;}
.amrd-nav a.active{background:rgba(13,148,136,.15);color:#5EEAD4;border-left-color:#0D9488;font-weight:600;}
.amrd-user{padding:14px 18px;border-top:1px solid rgba(255,255,255,.08);}
.amrd-user-name{color:#e2e8f0;font-size:13px;font-weight:600;}
.amrd-user-role{color:#64748b;font-size:11px;margin-top:2px;}
.amrd-logout{margin-top:10px;width:100%;padding:7px;background:rgba(255,255,255,.07);border:none;
 border-radius:6px;color:#94a3b8;font-size:12px;cursor:pointer;transition:background .15s;text-align:center;}
.amrd-logout:hover{background:rgba(255,255,255,.12);color:#e2e8f0;}
.amrd-main{flex:1;display:flex;flex-direction:column;min-width:0;}
.amrd-topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 28px;
 display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.amrd-topbar-title{font-size:18px;font-weight:700;color:#0f172a;}
.amrd-content{padding:28px;flex:1;overflow-y:auto;}
.amrd-card{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.07);padding:24px;margin-bottom:20px;}
.amrd-card h3{margin:0 0 16px;font-size:15px;font-weight:600;color:#0f172a;}
.amrd-table{width:100%;border-collapse:collapse;font-size:13px;}
.amrd-table th{text-align:left;padding:10px 14px;color:#64748b;font-size:11px;font-weight:700;
 text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid #f1f5f9;}
.amrd-table td{padding:12px 14px;border-bottom:1px solid #f8fafc;color:#334155;}
.amrd-table tr:last-child td{border-bottom:none;}
.amrd-table tr:hover td{background:#f8fafc;}
.amrd-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;}
.amrd-badge-active{background:#dcfce7;color:#15803d;}
.amrd-badge-draft{background:#f1f5f9;color:#64748b;}
.amrd-badge-sent{background:#dbeafe;color:#1d4ed8;}
.amrd-badge-paid{background:#dcfce7;color:#15803d;}
.amrd-badge-overdue{background:#fee2e2;color:#dc2626;}
.amrd-badge-suspended,.amrd-badge-cancelled{background:#fee2e2;color:#dc2626;}
.amrd-btn{padding:8px 16px;border-radius:7px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all .15s;}
.amrd-btn-primary{background:#0D9488;color:#fff;} .amrd-btn-primary:hover{background:#0B7A70;}
.amrd-btn-sm{padding:5px 12px;font-size:12px;}
.amrd-btn-ghost{background:#f1f5f9;color:#334155;} .amrd-btn-ghost:hover{background:#e2e8f0;}
.amrd-stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:20px;}
.amrd-stat{background:#fff;border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.07);}
.amrd-stat-label{font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}
.amrd-stat-value{font-size:28px;font-weight:700;color:#0f172a;margin-top:6px;}
.amrd-stat-sub{font-size:12px;color:#94a3b8;margin-top:4px;}
.amrd-form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
.amrd-form-row.full{grid-template-columns:1fr;}
label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:5px;}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:7px;
 font-size:13px;color:#111827;background:#fff;font-family:inherit;}
input:focus,select:focus,textarea:focus{outline:none;border-color:#0D9488;box-shadow:0 0 0 2px rgba(13,148,136,.15);}
@media print{.amrd-sidebar,.amrd-topbar{display:none!important;}.amrd-main{overflow:visible!important;}}`;
        document.head.appendChild(s);
    }

    function renderSidebar(pageTitle) {
        _injectStyles();
        requireLogin();
        _startSessionTimeout();

        const staff      = getStaff();
        const activePath = location.pathname.replace(/\/+$/, '') || '/dashboard';

        const _navLink = n => {
            const active = activePath.endsWith(n.href.replace(/^\//, '')) ? ' active' : '';
            return `<a href="${n.href}" class="${active}">${_icon(n.icon)}${n.label}</a>`;
        };

        const navItems = NAV.map(_navLink).join('');

        const adminSection = staff?.role === 'site_admin'
            ? `<div style="padding:8px 18px 4px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#475569;margin-top:8px;">Administration</div>
               ${ADMIN_NAV.map(_navLink).join('')}`
            : '';

        const sidebar = document.createElement('aside');
        sidebar.className = 'amrd-sidebar';
        sidebar.innerHTML = `
            <a href="/" class="amrd-logo">
                <img src="/images/logo.svg" alt="AmaraData" class="amrd-logo-icon"/>
                <div class="amrd-logo-text">
                    <div class="amrd-logo-title">AmaraData</div>
                    <div class="amrd-logo-sub">Platform Console</div>
                </div>
            </a>
            <nav class="amrd-nav">${navItems}${adminSection}</nav>
            <div class="amrd-user">
                <div class="amrd-user-name">${staff?.name || '—'}</div>
                <div class="amrd-user-role">${staff?.role || ''}</div>
                <button class="amrd-logout" onclick="window.__amrd.logout()">Sign out</button>
            </div>`;

        const main = document.createElement('div');
        main.className = 'amrd-main';

        const topbar = document.createElement('div');
        topbar.className = 'amrd-topbar';
        topbar.innerHTML = `<span class="amrd-topbar-title">${pageTitle || ''}</span>`;
        main.appendChild(topbar);

        const content = document.createElement('div');
        content.className = 'amrd-content';
        while (document.body.firstChild) content.appendChild(document.body.firstChild);
        main.appendChild(content);

        const wrap = document.createElement('div');
        wrap.className = 'amrd-wrap';
        wrap.appendChild(sidebar);
        wrap.appendChild(main);
        document.body.appendChild(wrap);
        document.body.style.margin = '0';

        return content;
    }

    window.__amrd = { login, logout, apiFetch, gqlFetch, getStaff, isLoggedIn, requireLogin, renderSidebar };
})();
