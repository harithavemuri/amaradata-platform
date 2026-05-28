// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PLATFORM_CODE = readFileSync(resolve('frontend/js/platform.js'), 'utf8');

function loadPlatform() {
    delete window.__amrd;
    new Function(PLATFORM_CODE)();
}

function makeResponse(overrides = {}) {
    return {
        ok:      true,
        status:  200,
        headers: new Headers(),
        json:    async () => ({ success: true }),
        ...overrides,
    };
}

describe('platform.js — apiFetch', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
        document.head.innerHTML = '';
        loadPlatform();
    });

    // ── Request headers ───────────────────────────────────────────────────────
    describe('request headers', () => {
        it('always sends Content-Type: application/json', async () => {
            let captured;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
                captured = opts.headers;
                return Promise.resolve(makeResponse());
            }));

            await window.__amrd.apiFetch('/api/test');
            expect(captured['Content-Type']).toBe('application/json');
        });

        it('always sends Accept: application/json;v=1', async () => {
            let captured;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
                captured = opts.headers;
                return Promise.resolve(makeResponse());
            }));

            await window.__amrd.apiFetch('/api/test');
            expect(captured['Accept']).toBe('application/json;v=1');
        });

        it('attaches Authorization header when token exists', async () => {
            localStorage.setItem('amrd_token', 'my-bearer-token');
            loadPlatform();
            let captured;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
                captured = opts.headers;
                return Promise.resolve(makeResponse());
            }));

            await window.__amrd.apiFetch('/api/tenants');
            expect(captured['Authorization']).toBe('Bearer my-bearer-token');
        });

        it('omits Authorization header when no token', async () => {
            let captured;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
                captured = opts.headers;
                return Promise.resolve(makeResponse());
            }));

            await window.__amrd.apiFetch('/api/contact', { method: 'POST' });
            expect(captured['Authorization']).toBeUndefined();
        });

        it('merges caller-supplied headers without losing defaults', async () => {
            let captured;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
                captured = opts.headers;
                return Promise.resolve(makeResponse());
            }));

            await window.__amrd.apiFetch('/api/test', { headers: { 'X-Custom': 'value' } });
            expect(captured['X-Custom']).toBe('value');
            expect(captured['Content-Type']).toBe('application/json');
        });
    });

    // ── Successful responses ──────────────────────────────────────────────────
    describe('successful responses', () => {
        it('returns parsed JSON body', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ json: async () => ({ success: true, data: [{ id: 1 }] }) })
            ));

            const result = await window.__amrd.apiFetch('/api/tenants');
            expect(result).toEqual({ success: true, data: [{ id: 1 }] });
        });

        it('throws with server error message on non-ok response', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ ok: false, status: 400, json: async () => ({ error: 'Bad request' }) })
            ));

            await expect(window.__amrd.apiFetch('/api/bad')).rejects.toThrow('Bad request');
        });
    });

    // ── NonDB badge ───────────────────────────────────────────────────────────
    describe('NonDB badge', () => {
        it('shows badge when X-DB-Mode: nondb header present', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ headers: new Headers({ 'X-DB-Mode': 'nondb', 'X-DB-Mode-Reason': 'env' }) })
            ));

            await window.__amrd.apiFetch('/api/test');
            const badge = document.getElementById('amrd-nondb-badge');
            expect(badge).not.toBeNull();
            expect(badge.textContent).toContain('NonDB Mode');
        });

        it('shows "DB Fallback" label when reason is "fallback"', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ headers: new Headers({ 'X-DB-Mode': 'nondb', 'X-DB-Mode-Reason': 'fallback' }) })
            ));

            await window.__amrd.apiFetch('/api/test');
            const badge = document.getElementById('amrd-nondb-badge');
            expect(badge).not.toBeNull();
            expect(badge.textContent).toContain('DB Fallback');
        });

        it('badge shown only once across multiple requests', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ headers: new Headers({ 'X-DB-Mode': 'nondb' }) })
            ));

            await window.__amrd.apiFetch('/api/test');
            await window.__amrd.apiFetch('/api/test');
            await window.__amrd.apiFetch('/api/test');

            const badges = document.querySelectorAll('#amrd-nondb-badge');
            expect(badges.length).toBe(1);
        });

        it('no badge when X-DB-Mode header absent', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse()));

            await window.__amrd.apiFetch('/api/test');
            expect(document.getElementById('amrd-nondb-badge')).toBeNull();
        });
    });

    // ── 401 token refresh flow ────────────────────────────────────────────────
    describe('401 refresh flow', () => {
        it('on 401 attempts token refresh then retries the original request', async () => {
            localStorage.setItem('amrd_token', 'expired-token');
            localStorage.setItem('amrd_refresh_token', 'valid-refresh');
            loadPlatform();

            let callCount = 0;
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
                if (url.includes('/api/auth/refresh')) {
                    return Promise.resolve(makeResponse({
                        json: async () => ({ token: 'new-access', refresh_token: 'new-refresh' }),
                    }));
                }
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(makeResponse({
                        ok: false, status: 401,
                        json: async () => ({ error: 'Unauthorized' }),
                    }));
                }
                return Promise.resolve(makeResponse({ json: async () => ({ success: true, data: [] }) }));
            }));

            const result = await window.__amrd.apiFetch('/api/tenants');
            expect(result).toEqual({ success: true, data: [] });
            expect(localStorage.getItem('amrd_token')).toBe('new-access');
        });

        it('on failed refresh shows access-denied modal', async () => {
            localStorage.setItem('amrd_token', 'expired');
            localStorage.setItem('amrd_refresh_token', 'also-expired');
            loadPlatform();

            vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
                if (url.includes('/api/auth/refresh')) {
                    return Promise.resolve(makeResponse({
                        ok: false, status: 401,
                        json: async () => ({ error: 'Refresh expired' }),
                    }));
                }
                return Promise.resolve(makeResponse({
                    ok: false, status: 401,
                    json: async () => ({ error: 'Unauthorized' }),
                }));
            }));

            await window.__amrd.apiFetch('/api/tenants');
            expect(document.getElementById('__access-denied-modal')).not.toBeNull();
        });

        it('does not retry refresh on the second 401 (_retry=false)', async () => {
            localStorage.setItem('amrd_token', 'tok');
            localStorage.setItem('amrd_refresh_token', 'rtok');
            loadPlatform();

            const fetchMock = vi.fn().mockImplementation((url) => {
                if (url.includes('/api/auth/refresh')) {
                    return Promise.resolve(makeResponse({
                        json: async () => ({ token: 'new', refresh_token: 'new-r' }),
                    }));
                }
                return Promise.resolve(makeResponse({
                    ok: false, status: 401,
                    json: async () => ({ error: 'Unauthorized' }),
                }));
            });
            vi.stubGlobal('fetch', fetchMock);

            await window.__amrd.apiFetch('/api/tenants');
            const refreshCalls = fetchMock.mock.calls.filter(c => c[0].includes('/api/auth/refresh'));
            expect(refreshCalls.length).toBe(1);
        });
    });

    // ── 403 access denied modal ───────────────────────────────────────────────
    describe('403 access denied', () => {
        it('shows access-denied modal on 403', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })
            ));

            await window.__amrd.apiFetch('/api/admin/users');
            const modal = document.getElementById('__access-denied-modal');
            expect(modal).not.toBeNull();
            expect(modal.innerHTML).toContain('Access Denied');
        });

        it('modal contains countdown and Stay button', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ ok: false, status: 403, json: async () => ({}) })
            ));

            await window.__amrd.apiFetch('/api/admin/roles');
            expect(document.getElementById('__adc')).not.toBeNull();
            expect(document.getElementById('__adstay')).not.toBeNull();
        });

        it('modal rendered only once even with multiple 403s', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
                makeResponse({ ok: false, status: 403, json: async () => ({}) })
            ));

            await window.__amrd.apiFetch('/api/admin/users');
            await window.__amrd.apiFetch('/api/admin/users');
            expect(document.querySelectorAll('#__access-denied-modal').length).toBe(1);
        });
    });
});
