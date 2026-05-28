// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PLATFORM_CODE = readFileSync(resolve('frontend/js/platform.js'), 'utf8');

function loadPlatform() {
    delete window.__amrd;
    new Function(PLATFORM_CODE)();
}

function setStaff(staff) {
    localStorage.setItem('amrd_staff', JSON.stringify(staff));
    localStorage.setItem('amrd_token', 'test-token');
}

const ADMIN_STAFF     = { id: 1, name: 'Alice', role: 'admin',      email: 'alice@t.com' };
const SITEADMIN_STAFF = { id: 2, name: 'Bob',   role: 'site_admin', email: 'bob@t.com'   };

describe('platform.js — renderSidebar', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
        vi.useFakeTimers();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        setStaff(ADMIN_STAFF);
        loadPlatform();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ── DOM structure ─────────────────────────────────────────────────────────
    describe('DOM structure', () => {
        it('creates .amrd-sidebar element', () => {
            window.__amrd.renderSidebar('Dashboard');
            expect(document.querySelector('.amrd-sidebar')).not.toBeNull();
        });

        it('creates .amrd-main wrapper with topbar and content', () => {
            window.__amrd.renderSidebar('Dashboard');
            expect(document.querySelector('.amrd-main')).not.toBeNull();
            expect(document.querySelector('.amrd-topbar')).not.toBeNull();
            expect(document.querySelector('.amrd-content')).not.toBeNull();
        });

        it('returns the .amrd-content div', () => {
            const content = window.__amrd.renderSidebar('Dashboard');
            expect(content).not.toBeNull();
            expect(content.className).toBe('amrd-content');
        });

        it('creates .amrd-wrap container', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.querySelector('.amrd-wrap')).not.toBeNull();
        });
    });

    // ── Styles injection ──────────────────────────────────────────────────────
    describe('styles', () => {
        it('injects #amrd-styles into <head>', () => {
            window.__amrd.renderSidebar('Dashboard');
            expect(document.getElementById('amrd-styles')).not.toBeNull();
        });

        it('injects styles only once (idempotent)', () => {
            window.__amrd.renderSidebar('Dashboard');
            window.__amrd.renderSidebar('Tenants');
            expect(document.querySelectorAll('#amrd-styles').length).toBe(1);
        });
    });

    // ── Page title ────────────────────────────────────────────────────────────
    describe('page title', () => {
        it('renders page title in topbar', () => {
            window.__amrd.renderSidebar('Billing Metrics');
            expect(document.body.innerHTML).toContain('Billing Metrics');
        });

        it('empty title does not crash', () => {
            expect(() => window.__amrd.renderSidebar('')).not.toThrow();
        });
    });

    // ── User info ─────────────────────────────────────────────────────────────
    describe('user info', () => {
        it('shows logged-in user name in sidebar', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).toContain('Alice');
        });

        it('shows user role in sidebar', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).toContain('admin');
        });

        it('shows — when no staff stored', () => {
            localStorage.removeItem('amrd_staff');
            loadPlatform();
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).toContain('—');
        });
    });

    // ── Navigation items ──────────────────────────────────────────────────────
    describe('main navigation', () => {
        it('renders all main nav links', () => {
            window.__amrd.renderSidebar('Home');
            const html = document.body.innerHTML;
            expect(html).toContain('Dashboard');
            expect(html).toContain('Tenants');
            expect(html).toContain('Invoices');
            expect(html).toContain('Enhancements');
            expect(html).toContain('Billing Metrics');
        });
    });

    // ── Admin section ─────────────────────────────────────────────────────────
    describe('admin user-management section', () => {
        it('NOT shown for admin role', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).not.toContain('User Management');
        });

        it('NOT shown for staff role', () => {
            setStaff({ id: 3, name: 'Staff', role: 'staff' });
            loadPlatform();
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).not.toContain('User Management');
        });

        it('IS shown for site_admin role', () => {
            setStaff(SITEADMIN_STAFF);
            loadPlatform();
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).toContain('User Management');
        });

        it('site_admin sees Users, User Groups, and Roles links', () => {
            setStaff(SITEADMIN_STAFF);
            loadPlatform();
            window.__amrd.renderSidebar('Home');
            const html = document.body.innerHTML;
            expect(html).toContain('Users');
            expect(html).toContain('User Groups');
            expect(html).toContain('Roles');
        });

        it('site_admin sees Sync to DB button in topbar', () => {
            setStaff(SITEADMIN_STAFF);
            loadPlatform();
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).toContain('Sync to DB');
        });

        it('non-site_admin does NOT see Sync to DB button', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.body.innerHTML).not.toContain('Sync to DB');
        });
    });

    // ── NonDB badge slot ──────────────────────────────────────────────────────
    describe('nondb badge slot', () => {
        it('renders #amrd-nondb-slot in topbar', () => {
            window.__amrd.renderSidebar('Home');
            expect(document.getElementById('amrd-nondb-slot')).not.toBeNull();
        });

        it('badge injected into slot when X-DB-Mode: nondb response received', async () => {
            window.__amrd.renderSidebar('Home');
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok:      true,
                status:  200,
                headers: new Headers({ 'X-DB-Mode': 'nondb', 'X-DB-Mode-Reason': 'env' }),
                json:    async () => ({ success: true }),
            }));

            await window.__amrd.apiFetch('/api/test');
            expect(document.getElementById('amrd-nondb-badge')).not.toBeNull();
        });
    });

    // ── Toggle sidebar ────────────────────────────────────────────────────────
    describe('sidebar toggle', () => {
        it('exposes __amrdToggleSidebar on window after renderSidebar', () => {
            window.__amrd.renderSidebar('Home');
            expect(typeof window.__amrdToggleSidebar).toBe('function');
        });

        it('toggles collapsed class on desktop viewport', () => {
            window.__amrd.renderSidebar('Home');
            Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
            const sidebar = document.querySelector('.amrd-sidebar');
            window.__amrdToggleSidebar();
            expect(sidebar.classList.contains('collapsed')).toBe(true);
            window.__amrdToggleSidebar();
            expect(sidebar.classList.contains('collapsed')).toBe(false);
        });
    });
});
