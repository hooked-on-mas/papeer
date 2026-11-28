// B13-search (T11): the two display conditions webOrdinaryLibraryQuery does not assert after a restart (tag and scope=all), the exact stored record
// (`paper-desk.library-query.v1:<scope>` in localStorage), and malformed stored values other than the literal JSON `null` that webOrdinaryLibraryQuery already covers.
// Product contract observed (LibraryQuerySession: "Reject malformed saved state rather than silently broadening a search"): a malformed record is NOT replaced by
// the defaults on its own; the screen shows an alert and an empty result, keeps the stored value as it is, and recovers only by an explicit action
// (clear the conditions, or repair the record and press retry). Observed: real DOM, real localStorage, real restarts of the browser profile.
// No time is asserted; every wait is an observation bounded only against a hang.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { createItemUi, showCatalog, waitCatalogClosed } from '../../support/ordinaryCatalog.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { waitForSnapshot } from '../../support/waitForSnapshot.ts';

const PREFIX = 'paper-desk.library-query.v1:';
const DEFAULTS = { text: '', scope: 'metadata', tag: '', read: 'all', sort: 'position', descending: false };
const ALERT = '検索条件を保存または復元できません';
type Shown = { ids: string[]; alerts: string[]; text: string; scope: string; tag: string; read: string; sort: string; descending: boolean; tags: string[] };

const shown = (page: Page): Promise<Shown> => page.evaluate(() => {
  const value = (label: string) => (document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '\u0000absent';
  return { ids: [...document.querySelectorAll('[role="tree"][aria-label="資料の階層"] [data-library-item]')].map(row => row.getAttribute('data-library-item')!),
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => (node.textContent ?? '').trim()),
    text: value('資料の検索語'), scope: value('資料の検索範囲'), tag: value('資料のタグ条件'), read: value('資料の読書状態'), sort: value('資料の並び順'),
    descending: (document.querySelector('[aria-label="資料を降順に表示"]') as HTMLInputElement | null)?.checked ?? false,
    tags: [...document.querySelectorAll('[aria-label="資料のタグ条件"] option')].map(option => (option as HTMLOptionElement).value) };
});
const until = (page: Page, accepts: (value: Shown) => boolean) => waitForSnapshot(() => shown(page), accepts, 60_000);
/** All localStorage records of this namespace family: key and raw string (the real stored value). */
const stored = (page: Page) => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort().map(key => ({ key, raw: localStorage.getItem(key) })), PREFIX);
const putRaw = (page: Page, key: string, raw: string) => page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
const record = (overrides: Record<string, unknown>) => JSON.stringify({ ...DEFAULTS, ...overrides });

async function note(page: Page, title: string, body: string) {
  const id = await createItemUi(page, title, 'markdown');
  if (body) {
    const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    await editor.fill(body); await editor.blur(); await ordinaryMarkdownSaved(page, id, body);
  }
  return id;
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Library restores the tag and scope=all conditions after restart and keeps the stored record exact (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page, phase = 'create';
  try {
    const one = await note(page, 'Tagged one', 'alphabody first\n');
    const two = await note(page, 'Plain two', 'alphabody second\n');
    const three = await note(page, 'Tagged three', 'unrelated third\n');
    await showCatalog(page);
    await page.getByLabel('「Tagged one」を選択', { exact: true }).check(); await page.getByLabel('「Tagged three」を選択', { exact: true }).check();
    await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
    const form = page.getByRole('form', { name: 'タグ編集', exact: true });
    await form.getByLabel('タグ（1行に1つ）', { exact: true }).fill('science');
    await form.getByRole('button', { name: 'タグを適用', exact: true }).click(); await form.waitFor({ state: 'hidden' });
    await until(page, value => value.tags.includes('science'));

    phase = 'set-conditions';
    await page.getByLabel('資料のタグ条件', { exact: true }).selectOption('science');
    await page.getByLabel('資料の検索範囲', { exact: true }).selectOption('all');
    await page.getByLabel('資料の検索語', { exact: true }).fill('alphabody');
    const before = await until(page, value => value.ids.length === 1 && value.tag === 'science' && value.scope === 'all');
    assert.deepEqual(before.ids, [one], 'tag AND body: only the tagged note whose body matches');
    const exact = record({ text: 'alphabody', scope: 'all', tag: 'science' });
    const records = await stored(page);
    assert.equal(records.length, 1, 'one stored record per Library scope'); assert.deepEqual(JSON.parse(records[0].raw!), JSON.parse(exact));
    const key = records[0].key;

    phase = 'restart-tag-and-all';
    page = await app.restartLibrary({ showCatalog: false });
    const restored = await until(page, value => value.ids.length === 1);
    assert.equal(restored.tag, 'science', 'the tag condition is restored'); assert.equal(restored.scope, 'all', 'scope=all is restored');
    assert.equal(restored.text, 'alphabody'); assert.deepEqual(restored.ids, [one]); assert.deepEqual(restored.alerts, []);
    assert.deepEqual(await stored(page), records, 'opening the Library does not rewrite the record');

    phase = 'restart-tag-only';
    await page.getByLabel('資料の検索語', { exact: true }).fill('');
    const tagged = await until(page, value => value.ids.length === 2 && value.text === '');
    assert.deepEqual(tagged.ids, [one, three], 'the tag filter alone, in the stored order');
    assert.deepEqual(JSON.parse((await stored(page))[0].raw!), JSON.parse(record({ scope: 'all', tag: 'science' })), 'the record follows the change');
    page = await app.restartLibrary({ showCatalog: false });
    const again = await until(page, value => value.ids.length === 2);
    assert.deepEqual([again.tag, again.scope, again.text], ['science', 'all', '']); assert.deepEqual(again.ids, [one, three]);
    assert.ok(!again.ids.includes(two), 'the untagged note stays out after the restart');

    phase = 'stale-tag';
    // A well-formed record naming a tag no item has any more: it is restored as written (not widened), and shows no result and no alert.
    await putRaw(page, key, record({ scope: 'all', tag: 'ghost' }));
    page = await app.restartLibrary({ showCatalog: false });
    const ghost = await until(page, value => value.tag === 'ghost');
    assert.deepEqual(ghost.ids, [], 'a tag nobody has matches nothing'); assert.deepEqual(ghost.alerts, []);
    assert.ok(ghost.tags.includes('ghost') && ghost.tags.includes('science'), 'the stale tag stays selectable next to the real ones');
    await page.getByRole('button', { name: '表示条件を解除', exact: true }).click();
    const cleared = await until(page, value => value.ids.length === 3 && value.tag === '');
    assert.deepEqual([cleared.scope, cleared.text, cleared.sort], ['metadata', '', 'position']);
    assert.deepEqual(JSON.parse((await stored(page))[0].raw!), DEFAULTS, 'clearing stores the defaults');
    t.diagnostic(JSON.stringify({ engine, ids: [one, two, three], restored: { tag: 'science', scope: 'all' }, storedRecordExact: true, staleTagNotWidened: true }));
  } catch (error) { t.diagnostic(JSON.stringify({ phase, shown: await shown(page).catch(String), stored: await stored(page).catch(String) })); throw error; }
});

const MALFORMED: { name: string; raw: string }[] = [
  { name: 'text that is not JSON', raw: '{not json' },
  { name: 'an unknown scope value', raw: record({ scope: 'everywhere' }) },
  { name: 'a tag of the wrong type', raw: record({ tag: 5 }) },
  { name: 'an unknown extra key', raw: JSON.stringify({ ...DEFAULTS, extra: 1 }) },
];
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Library keeps working with malformed stored conditions and recovers only by an explicit action (${engine})`, { timeout: 480_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page, phase = 'create';
  try {
    const a = await note(page, 'Quiet alpha', ''); await waitCatalogClosed(page);
    const b = await note(page, 'Quiet beta', ''); await showCatalog(page);
    await page.getByLabel('資料の検索語', { exact: true }).fill('quiet');
    await until(page, value => value.ids.length === 2);
    const [{ key, raw }] = await stored(page); assert.ok(raw);

    for (const [index, variant] of MALFORMED.entries()) {
      phase = `malformed-${index}`;
      await putRaw(page, key, variant.raw);
      page = await app.restartLibrary({ showCatalog: false });
      const blocked = await until(page, value => value.alerts.some(text => text.includes(ALERT)));
      assert.deepEqual(blocked.ids, [], `${variant.name}: no result is shown (the library is not silently widened)`);
      assert.equal(blocked.alerts.length, 1, `${variant.name}: exactly one alert`);
      assert.equal(await page.getByRole('button', { name: '検索条件を再試行', exact: true }).count(), 1, `${variant.name}: a retry button is offered`);
      assert.deepEqual(await stored(page), [{ key, raw: variant.raw }], `${variant.name}: the stored value is left as it was (no automatic rewrite)`);
      assert.equal(await page.getByRole('button', { name: '表示条件を解除', exact: true }).isEnabled(), true, `${variant.name}: the screen still responds`);
      if (index === 0) {
        // Repair the record from outside and retry: the conditions in it are applied.
        phase = 'repair-and-retry';
        await putRaw(page, key, record({ text: 'beta', scope: 'metadata' }));
        await page.getByRole('button', { name: '検索条件を再試行', exact: true }).click();
        const retried = await until(page, value => value.alerts.length === 0 && value.ids.length === 1);
        assert.deepEqual(retried.ids, [b], 'the repaired record is applied by the retry'); assert.equal(retried.text, 'beta');
        assert.deepEqual(await stored(page), [{ key, raw: record({ text: 'beta', scope: 'metadata' }) }]);
      } else if (index === MALFORMED.length - 1) {
        phase = 'explicit-clear';
        await page.getByRole('button', { name: '表示条件を解除', exact: true }).click();
        const cleared = await until(page, value => value.alerts.length === 0 && value.ids.length === 2);
        assert.deepEqual([cleared.text, cleared.scope, cleared.tag, cleared.read, cleared.sort, cleared.descending], ['', 'metadata', '', 'all', 'position', false]);
        assert.deepEqual(JSON.parse((await stored(page))[0].raw!), DEFAULTS, 'the clear replaces the malformed record by the defaults');
        page = await app.restartLibrary({ showCatalog: false });
        const reopened = await until(page, value => value.ids.length === 2);
        assert.deepEqual(reopened.alerts, [], 'after the clear the next start has no alert'); assert.deepEqual([...reopened.ids].sort(), [a, b].sort());
      }
    }
    t.diagnostic(JSON.stringify({ engine, variants: MALFORMED.map(variant => variant.name), blockedWithAlertAndEmptyResult: true, storedValueUntouched: true,
      retryAppliesRepairedRecord: true, explicitClearRestoresDefaults: true }));
  } catch (error) { t.diagnostic(JSON.stringify({ phase, shown: await shown(page).catch(String), stored: await stored(page).catch(String) })); throw error; }
});
