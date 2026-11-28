// Observation and operation helpers for the ordinary Web display-settings matrix (B13-f). Real DOM, real localStorage records and the real IndexedDB
// catalog roots only: nothing here seeds a Library, injects a session or imports a product session class.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export const WORKSPACE_PREFIX = 'paper-desk.workspace.v1:';
export const INK_PREFIX = 'papeer.document-ink-preferences.v1:';
/** Written out here on purpose (not imported from the product): the plan names exactly these choices. */
export const UI_SCALE_VALUES = [0.9, 1, 1.1, 1.25, 1.5] as const;
export const EDITOR_WIDTH_VALUES = [30, 40, 50, 60, 70] as const;
export const SIDEBAR_WIDTH_VALUES = [240, 280, 320, 380] as const;
export type Theme = 'system' | 'light' | 'dark';
export type Display = { theme: Theme; uiScale: number; editorWidth: number; sidebarWidth: number };

export type StoredRecord = { key: string; scope: [string, string, string]; raw: string };

/** Every localStorage entry whose key starts with `prefix`, in key order. The scope is decoded from the key (a JSON triple). */
export async function storedRecords(page: Page, prefix: string): Promise<StoredRecord[]> {
  const rows = await page.evaluate(prefix => {
    const out: { key: string; raw: string }[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null && key.startsWith(prefix)) out.push({ key, raw: localStorage.getItem(key) ?? '' });
    }
    return out.sort((a, b) => a.key < b.key ? -1 : 1);
  }, prefix);
  return rows.map(row => {
    const scope = JSON.parse(row.key.slice(prefix.length)) as unknown;
    assert.ok(Array.isArray(scope) && scope.length === 3 && scope.every(value => typeof value === 'string'), `a scope triple in ${row.key}`);
    return { ...row, scope: scope as [string, string, string] };
  });
}

export async function onlyRecord(page: Page, prefix: string): Promise<StoredRecord> {
  const rows = await storedRecords(page, prefix);
  assert.equal(rows.length, 1, `exactly one ${prefix} record (found ${rows.length})`);
  return rows[0];
}

/** Library ids of the catalog roots in the real IndexedDB (read only; never opens an upgrade). */
export async function catalogLibraryIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(['roots'], 'readonly'), roots = tx.objectStore('roots').getAll();
        tx.onabort = () => reject(tx.error ?? new Error('roots read aborted'));
        tx.oncomplete = () => resolve((roots.result as { value: { kind: string; id: string } }[]).filter(row => row.value.kind === 'library').map(row => row.value.id).sort());
      });
    } finally { db.close(); }
  });
}

export type Observed = { dataTheme: string | null; fontSizeStyle: string; fontPx: number; editorVar: string; sidebarVar: string;
  colorScheme: string; bodyBackground: string; innerWidth: number; innerHeight: number };
export async function readDisplay(page: Page): Promise<Observed> {
  return page.evaluate(() => {
    const root = document.documentElement, style = getComputedStyle(root);
    return { dataTheme: root.dataset.theme ?? null, fontSizeStyle: root.style.fontSize, fontPx: Number.parseFloat(style.fontSize),
      editorVar: root.style.getPropertyValue('--workspace-editor-width'), sidebarVar: root.style.getPropertyValue('--workspace-sidebar-width'),
      colorScheme: style.colorScheme, bodyBackground: getComputedStyle(document.body).backgroundColor, innerWidth, innerHeight };
  });
}

const dialogName = 'このライブラリの表示設定';
export async function openSettings(page: Page) {
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true }); await dialog.waitFor();
  return dialog;
}
export async function closeSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  await dialog.getByRole('button', { name: '表示設定を閉じる', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
}
export async function selectValues(page: Page, label: string): Promise<string[]> {
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
  return dialog.getByLabel(label, { exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
}
export async function changeDisplay(page: Page, patch: Partial<Display>) {
  const dialog = await openSettings(page);
  if (patch.theme !== undefined) await dialog.getByLabel('配色', { exact: true }).selectOption(patch.theme);
  if (patch.uiScale !== undefined) await dialog.getByLabel('文字の大きさ', { exact: true }).selectOption(String(patch.uiScale));
  if (patch.editorWidth !== undefined) await dialog.getByLabel('右側の編集幅', { exact: true }).selectOption(String(patch.editorWidth));
  if (patch.sidebarWidth !== undefined) await dialog.getByLabel('サイドバーの幅', { exact: true }).selectOption(String(patch.sidebarWidth));
  await closeSettings(page);
}
/** The four select values as the dialog shows them right now (opens and closes the dialog). */
export async function shownDisplay(page: Page): Promise<Display> {
  const dialog = await openSettings(page);
  const value = async (label: string) => dialog.getByLabel(label, { exact: true }).inputValue();
  const shown = { theme: await value('配色') as Theme, uiScale: Number(await value('文字の大きさ')), editorWidth: Number(await value('右側の編集幅')),
    sidebarWidth: Number(await value('サイドバーの幅')) };
  await closeSettings(page);
  return shown;
}
export function parseRecord(raw: string): unknown { return JSON.parse(raw); }

/** Back to the chooser through the ordinary button, create a second Library through the ordinary form and open it. */
export async function createAndOpenLibrary(page: Page, title: string) {
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).waitFor();
  await page.getByLabel('新しいライブラリの名前').fill(title);
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).waitFor();
}
export async function switchToLibrary(page: Page, title: string) {
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).waitFor();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).or(page.locator('[data-content-document]:not([data-content-document=""])')).first().waitFor();
}
