// @ts-check
// Automated a11y + responsive-layout coverage for the public-facing pages.
// Scoped to the pages that matter most for compliance/SEO (marketing homepage,
// login) rather than every admin screen — those are behind auth and lower
// priority for this check; extend here if a specific admin page needs it.
import { test, expect } from './helpers/perf-tracking.js';
import AxeBuilder from '@axe-core/playwright';

const VIEWPORTS = [
    { name: 'mobile',  width: 375,  height: 812 },
    { name: 'tablet',  width: 768,  height: 1024 },
    { name: 'desktop', width: 1440, height: 900 },
];

const PAGES = ['/', '/login'];

for (const path of PAGES) {
    test.describe(`Accessibility — ${path}`, () => {
        test(`no axe violations at desktop viewport`, async ({ page }) => {
            await page.goto(path);
            const results = await new AxeBuilder({ page }).analyze();
            const summary = results.violations.map(v => `${v.id} (${v.impact}, ${v.nodes.length} node(s)): ${v.help}`);
            expect(summary, summary.join('\n')).toEqual([]);
        });

        for (const vp of VIEWPORTS) {
            test(`no horizontal overflow at ${vp.name} (${vp.width}px)`, async ({ page }) => {
                await page.setViewportSize({ width: vp.width, height: vp.height });
                await page.goto(path);
                const hasHScroll = await page.evaluate(
                    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
                );
                expect(hasHScroll, `${path} overflows horizontally at ${vp.width}px`).toBe(false);
            });
        }
    });
}
