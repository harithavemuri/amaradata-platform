// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PLATFORM_CODE = readFileSync(resolve('frontend/js/platform.js'), 'utf8');

function loadPlatform() {
    delete window.__amrd;
    new Function(PLATFORM_CODE)();
}

describe('platform.js — auth helpers', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
        loadPlatform();
    });

    // ── isLoggedIn / token getters ────────────────────────────────────────────
    describe('isLoggedIn()', () => {
        it('returns false when no token in localStorage', () => {
            expect(window.__amrd.isLoggedIn()).toBe(false);
        });

        it('returns true when amrd_token is set', () => {
            localStorage.setItem('amrd_token', 'valid-token');
            loadPlatform();
            expect(window.__amrd.isLoggedIn()).toBe(true);
        });
    });

    // ── getStaff ──────────────────────────────────────────────────────────────
    describe('getStaff()', () => {
        it('returns null when nothing stored', () => {
            expect(window.__amrd.getStaff()).toBeNull();
        });

        it('parses and returns stored staff JSON', () => {
            const staff = { id: 1, email: 'admin@t.com', name: 'Admin', role: 'admin' };
            localStorage.setItem('amrd_staff', JSON.stringify(staff));
            loadPlatform();
            expect(window.__amrd.getStaff()).toEqual(staff);
        });

        it('returns null for malformed JSON (no crash)', () => {
            localStorage.setItem('amrd_staff', '{ bad json }');
            loadPlatform();
            expect(window.__amrd.getStaff()).toBeNull();
        });

        it('returns null for empty stored value', () => {
            localStorage.setItem('amrd_staff', 'null');
            loadPlatform();
            expect(window.__amrd.getStaff()).toBeNull();
        });
    });

    // ── login() ───────────────────────────────────────────────────────────────
    describe('login()', () => {
        it('on success stores access token, refresh token, and staff', async () => {
            const user = { id: 5, email: 'u@test.com', name: 'User', role: 'staff' };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ token: 'access-tok', refresh_token: 'refresh-tok', user }),
            }));

            const result = await window.__amrd.login('u@test.com', 'password');
            expect(result).toEqual(user);
            expect(localStorage.getItem('amrd_token')).toBe('access-tok');
            expect(localStorage.getItem('amrd_refresh_token')).toBe('refresh-tok');
            expect(JSON.parse(localStorage.getItem('amrd_staff'))).toEqual(user);
        });

        it('throws with server error message on bad credentials', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                json: async () => ({ error: 'Invalid credentials' }),
            }));
            await expect(window.__amrd.login('bad@t.com', 'wrong')).rejects.toThrow('Invalid credentials');
        });

        it('throws generic "Login failed" when server sends no error field', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                json: async () => ({}),
            }));
            await expect(window.__amrd.login('x@t.com', 'x')).rejects.toThrow('Login failed');
        });

        it('POSTs to /api/auth/login with correct headers', async () => {
            let capturedInit;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
                capturedInit = init;
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ token: 't', refresh_token: 'r', user: { id: 1 } }),
                });
            }));

            await window.__amrd.login('a@b.com', 'pass');
            expect(capturedInit.method).toBe('POST');
            expect(capturedInit.headers['Content-Type']).toBe('application/json');
            expect(capturedInit.headers['Accept']).toBe('application/json;v=1');
        });

        it('does not store anything when login fails', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                json: async () => ({ error: 'Unauthorized' }),
            }));
            try { await window.__amrd.login('bad@t.com', 'bad'); } catch {}
            expect(localStorage.getItem('amrd_token')).toBeNull();
            expect(localStorage.getItem('amrd_staff')).toBeNull();
        });
    });

    // ── logout() ──────────────────────────────────────────────────────────────
    describe('logout()', () => {
        beforeEach(() => {
            // Suppress jsdom "Not implemented: navigation" by overriding location.href setter
            delete window.location;
            window.location = { href: '', pathname: '/dashboard', assign: vi.fn(), replace: vi.fn() };
        });

        it('clears amrd_token, amrd_refresh_token, and amrd_staff from localStorage', () => {
            localStorage.setItem('amrd_token', 'tok');
            localStorage.setItem('amrd_refresh_token', 'rtok');
            localStorage.setItem('amrd_staff', '{"id":1}');
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

            window.__amrd.logout();

            expect(localStorage.getItem('amrd_token')).toBeNull();
            expect(localStorage.getItem('amrd_refresh_token')).toBeNull();
            expect(localStorage.getItem('amrd_staff')).toBeNull();
        });

        it('calls POST /api/auth/logout', () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: true });
            vi.stubGlobal('fetch', fetchMock);

            window.__amrd.logout();

            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/api/auth/logout'),
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('redirects to /login after clearing session', () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
            window.__amrd.logout();
            expect(window.location.href).toBe('/login');
        });
    });
});
