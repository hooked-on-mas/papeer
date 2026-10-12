import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { DEV_TOKEN, SIDECAR_PORT, waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, waitForLibrary } from "../lib/ui.ts";

scenario("HTML資料の取込・切替・管理とスクリプトの隔離を実画面で確かめる", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1366, height: 900 }, timeout: 180_000,
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const base = `/api/papers/${owner}/attachments`, docs = `/api/papers/${owner}/documents`;
  const screenshots = path.join(os.tmpdir(), "paper-desk-e-visual");
  fs.mkdirSync(screenshots, { recursive: true });
  // Progress markers (no URL, token or document text) so a later stall can be placed from the log alone.
  const startedAt = Date.now();
  const mark = (step: string) => console.log(`[htmlDocuments +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${step}`);
  // frame.evaluate() has no timeout of its own: nothing the frame runs may block the test for good.
  const bounded = <T,>(work: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} が ${ms}ms で終わりませんでした`)), ms); });
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  };
  let externalRequests = 0;
  const server = http.createServer((_request, response) => { externalRequests++; response.end("outside"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const outside = `http://127.0.0.1:${address.port}/outside`;
  try {
    mark("start");
    await waitForLibrary(page, ["Stochastic Gradient"]);
    await openPaper(page, "Stochastic Gradient");
    const source = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#eff6ff;padding:24px}h1{color:rgb(22,101,52)}.card{background:white;padding:20px;border-radius:12px}</style></head><body><h1>図解サマリー</h1><div class="card"><img id="embedded" width="32" height="32" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%232563eb'/%3E%3C/svg%3E"><p>CSS と画像を埋め込んだ資料</p><button id="interactive" onclick="this.textContent='動きました'">動かす</button><button id="navigate" onclick="location.href='${outside}'">外部へ</button><form action="${outside}"><button id="submit">送信</button></form><pre id="script">停止</pre></div><script>document.getElementById('script').textContent='実行済み';</script></body></html>`;
    await libraryRow(page, "Stochastic Gradient").evaluate((element, content) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([content], "図解.html", { type: "text/html" }));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, source);
    await waitFor(async () => (await api.call("GET", base)).length === 1, "HTMLドロップで資料が保存されること");
    const first = (await api.call("GET", base))[0]; assert.equal(first.format, "html");
    const paper = libraryRow(page, "Stochastic Gradient");
    await paper.getByLabel("持ち物 1件", { exact: true }).waitFor();
    await paper.focus(); await paper.press("ArrowRight");
    await page.locator(`[data-tree-key="attachment:${owner}:${first.id}"]`).click();
    const selector = page.getByRole("combobox", { name: "資料を選択", exact: true });
    const frame = () => page.frameLocator('iframe[title="図解.html"]');
    await frame().getByRole("heading", { name: "図解サマリー", exact: true }).waitFor();
    assert.equal(await frame().locator("#script").innerText(), "停止");
    const display = await frame().locator("h1").evaluate(element => ({ color: getComputedStyle(element).color, origin: location.origin }));
    assert.equal(display.color, "rgb(22, 101, 52)");
    assert.equal(await frame().locator("#embedded").evaluate(element => (element as HTMLImageElement).naturalWidth), 32);
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    const src = await page.locator("iframe").getAttribute("src"); assert.ok(src && !src.includes("token"));
    mark("import: document shown with scripts stopped");
    const persisted = await fetch(src, { signal: AbortSignal.timeout(5_000) }); assert.equal(await persisted.text(), source);
    assert.ok(persisted.headers.get("content-security-policy")?.includes("sandbox;"));
    await page.screenshot({ path: path.join(screenshots, "01-html-panel-script-stopped.png") });
    mark("script allow: click");
    await page.getByLabel("この資料のスクリプトを許可", { exact: true }).click();
    await page.getByRole("dialog", { name: "資料内の動きを許可", exact: true }).getByRole("button", { name: "この資料に許可", exact: true }).click();
    await frame().locator("#script").filter({ hasText: "実行済み" }).waitFor();
    await frame().getByRole("button", { name: "動かす", exact: true }).click();
    await frame().getByRole("button", { name: "動きました", exact: true }).waitFor();
    mark("script allow: script ran in the frame");
    // The frame cannot reach the app's IPC, shown with the key the app itself uses. Nothing here may return, write or
    // log the invoke key or the token: the frame keeps the key in a closure and reports only booleans and statuses.
    //  1. A wrapper around window.fetch (always calling the real one, so connect-src 'none' still blocks) reads the
    //     Tauri-Invoke-Key header of the app's own invoke("get_backend_config"). That call falls back to the native
    //     postMessage with the same key once the custom protocol is refused.
    //  2. With that observed key (never an invented one) a raw message is posted over the same native bridge.
    //  3. Tauri runs a native reply in the main frame (wry executes it there), so the raw message names two
    //     callback ids that the MAIN frame registered beforehand with transformCallback (their ids are random, so
    //     the main frame registers first and hands only the numbers over). Those main observers record booleans:
    //     replied, errored, config-shaped, carries the token. The frame defines same-id observers in its own
    //     callbacks Map (runCallback itself cannot be wrapped: it is a non-writable property), in case a reply
    //     does land there.
    // Every wait is capped (main invoke 3 s, frame invoke 800 ms, native 800 ms, whole probe 10 s, then 250 ms for a
    // late main-frame reply). A reply that never comes counts as denied, its status says which kind; an answer, a
    // config-shaped value or the token anywhere fails the test. Observed values are never returned, saved or logged.
    const observerName = "__paperDeskMainObserver";
    let observerIds: { callback: number; error: number } | null = null;
    let isolation: Record<string, any>;
    const mainFrame = {
      observable: false, positiveControl: { configValid: false, tokenMatches: false },
      reply: false, error: false, configShaped: false, hasToken: false, cleaned: false,
    };
    try {
      observerIds = await bounded(page.evaluate(({ name, secret }) => {
        const w = window as any, internals = w.__TAURI_INTERNALS__;
        if (typeof internals?.transformCallback !== "function" || typeof internals.runCallback !== "function") return null;
        const state = { reply: false, error: false, configShaped: false, hasToken: false };
        // Only booleans are kept: what a callback received is looked at once and dropped.
        const look = (data: unknown) => {
          if (Array.isArray(data) && data.length === 2 && typeof data[0] === "number" && typeof data[1] === "string") state.configShaped = true;
          let text = "", json = "";
          try { text = String(data); } catch { /* not printable */ }
          try { json = JSON.stringify(data) ?? ""; } catch { /* circular or unserializable */ }
          if (text.includes(secret) || json.includes(secret)) state.hasToken = true;
        };
        // once = false: running the callback must not remove it, so the check below can run it and it still stays.
        const callback = internals.transformCallback((data: unknown) => { state.reply = true; look(data); }, false) as number;
        const error = internals.transformCallback((data: unknown) => { state.error = true; look(data); }, false) as number;
        w[name] = { state, ids: [callback, error] };
        return { callback, error };
      }, { name: observerName, secret: DEV_TOKEN }), 3_000, "主フレームの観測器の登録");

      // Do the observers work, and do they stay registered after running once? Run each twice, clearing in between.
      const verified = await bounded(page.evaluate(name => {
        const w = window as any, internals = w.__TAURI_INTERNALS__, held = w[name];
        if (!held) return { live: false, stays: false };
        const [callback, error] = held.ids as number[], state = held.state;
        const runBoth = () => { internals.runCallback(callback, null); internals.runCallback(error, null); };
        const clear = () => { state.reply = false; state.error = false; state.configShaped = false; state.hasToken = false; };
        runBoth(); const live = state.reply === true && state.error === true; clear();
        runBoth(); const stays = state.reply === true && state.error === true; clear();
        return { live, stays };
      }, observerName), 3_000, "主フレームの観測器の動作確認");
      mainFrame.observable = observerIds !== null && verified.live && verified.stays;

      // A positive control: the main frame itself invokes get_backend_config, which must work and carry the valid
      // token. This shows a main-origin invocation reaches the backend and that the key the app holds is valid.
      mainFrame.positiveControl = await bounded(page.evaluate(async ({ secret, limit }) => {
        const none = { configValid: false, tokenMatches: false };
        const internals = (window as any).__TAURI_INTERNALS__;
        if (typeof internals?.invoke !== "function") return none;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([
            internals.invoke("get_backend_config") as Promise<unknown>,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), limit); }),
          ]);
          const configValid = Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string";
          return { configValid, tokenMatches: configValid && (value as unknown[])[1] === secret };
        } catch { return none; } finally { clearTimeout(timer); }
      }, { secret: DEV_TOKEN, limit: 2_500 }), 3_000, "主フレームの設定取得（陽性対照）");
      mark(`isolation: main-frame observers ${mainFrame.observable ? "ready" : "NOT observable"}, `
        + `control configValid=${mainFrame.positiveControl.configValid} tokenMatches=${mainFrame.positiveControl.tokenMatches}`);

      isolation = await bounded(frame().locator("body").evaluate(async (_body, { secret, limit, port, ids }) => {
        const w = window as any;
        type Outcome = { status: "resolved"; value: unknown } | { status: "rejected"; reason: unknown } | { status: "timeout" };
        const settle = (work: Promise<unknown>): Promise<Outcome> => new Promise(resolve => {
          const timer = setTimeout(() => resolve({ status: "timeout" }), limit);
          work.then(value => { clearTimeout(timer); resolve({ status: "resolved", value }); },
            reason => { clearTimeout(timer); resolve({ status: "rejected", reason }); });
        });
        const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
        // The invoke key, once seen. It never leaves this closure.
        const captured: { key: string | null } = { key: null };
        const contains = (value: unknown, needle: string | null) => {
          if (!needle) return false;
          let text = "", json = "";
          try { text = String(value); } catch { /* not printable */ }
          try { json = JSON.stringify(value) ?? ""; } catch { /* circular or unserializable */ }
          return text.includes(needle) || json.includes(needle);
        };
        // The kind of a value, never the value: the result is written to disk.
        const shape = (value: unknown) => ({
          type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
          configShaped: Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "string",
          hasSecret: contains(value, secret),
          hasInvokeKey: contains(value, captured.key),
        });
        const redact = (text: string) => {
          const hidden = text.split(secret).join("[redacted]");
          return captured.key ? hidden.split(captured.key).join("[redacted]") : hidden;
        };
        const result: Record<string, any> = {
          parentDenied: false, storageDenied: false, tokenVisible: w.__PAPEER_TOKEN !== undefined && w.__PAPEER_TOKEN !== null,
          bridge: {
            origin: location.origin, internals: typeof w.__TAURI_INTERNALS__, invoke: typeof w.__TAURI_INTERNALS__?.invoke,
            transform: typeof w.__TAURI_INTERNALS__?.transformCallback,
            ipc: typeof w.ipc?.postMessage, webview: typeof w.chrome?.webview?.postMessage,
          },
        };
        try { void parent.document.body; } catch { result.parentDenied = true; }
        try { localStorage.setItem("untrusted", "x"); } catch { result.storageDenied = true; }

        // A real fetch to the running sidecar. no-cors leaves nothing but the document's CSP (connect-src 'none') to
        // stop it: a rejection is that policy at work, not a CORS or connection problem.
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), limit);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/papers`, { mode: "no-cors", signal: controller.signal });
          result.api = { status: "resolved", http: response.status, type: response.type };
        } catch { result.api = { status: controller.signal.aborted ? "timeout" : "rejected" }; } finally { clearTimeout(abort); }

        // The app's own invoke, with window.fetch wrapped for the length of the attempt. The real fetch always runs.
        result.ipcFetch = { calls: 0, outcome: "none" };
        let invokeFinal: Record<string, unknown> = { state: "pending" };
        if (typeof w.__TAURI_INTERNALS__?.invoke !== "function") result.invoke = { status: "no-bridge" };
        else {
          const original = w.fetch;
          const wrapper = (...args: unknown[]) => {
            try {
              const [input, init] = args as [any, any];
              const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
              const seen = headers.get("Tauri-Invoke-Key");
              if (seen) {
                captured.key = seen;
                result.ipcFetch.calls++;
              }
            } catch { /* observing must never change the call */ }
            const pending = Reflect.apply(original, w, args) as Promise<unknown>;
            if (captured.key) {
              result.ipcFetch.outcome = "pending";
              pending.then(() => { result.ipcFetch.outcome = "resolved"; }, () => { result.ipcFetch.outcome = "rejected"; });
            }
            return pending;
          };
          w.fetch = wrapper;
          try {
            let attempt: Promise<unknown>;
            try { attempt = Promise.resolve(w.__TAURI_INTERNALS__.invoke("get_backend_config")); } catch (error) { attempt = Promise.reject(error); }
            attempt.then(value => { invokeFinal = { state: "resolved", ...shape(value) }; },
              reason => { invokeFinal = { state: "rejected", reasonType: typeof reason }; });
            const outcome = await settle(attempt);
            if (outcome.status === "resolved") result.invoke = { status: "resolved", ...shape(outcome.value) };
            else if (outcome.status === "rejected") {
              const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
              result.invoke = { status: "rejected", reasonType: typeof outcome.reason, reason: redact(message).slice(0, 160) };
            } else result.invoke = { status: "timeout" };
          } finally { if (w.fetch === wrapper) w.fetch = original; }
        }
        result.invokeKeyObserved = captured.key !== null;

        // The native bridge with the key that was observed. Without one nothing is posted: an invented key would
        // only make the app print its real key to stderr. The callback ids are the main frame's observers' (numbers
        // only); same-id observers go into this frame's own callbacks Map for the length of the attempt.
        const post: [string, (message: string) => void] | null = w.chrome?.webview?.postMessage
          ? ["chrome.webview", message => w.chrome.webview.postMessage(message)]
          : w.ipc?.postMessage ? ["ipc", message => w.ipc.postMessage(message)] : null;
        if (!post) result.native = { status: "no-bridge", validKeyAttempted: false };
        else if (ids === null) result.native = { status: "no-observer-ids", via: post[0], validKeyAttempted: false };
        else if (captured.key === null) result.native = { status: "key-unavailable", via: post[0], validKeyAttempted: false };
        else {
          const replies: Array<ReturnType<typeof shape>> = [];
          let webMessages = 0, notify = () => {};
          const arrived = new Promise<void>(resolve => { notify = resolve; });
          const observe = (data: unknown) => { replies.push(shape(data)); notify(); };
          const map = w.__TAURI_INTERNALS__?.callbacks;
          const held = map instanceof Map;
          if (held) { map.set(ids.callback, observe); map.set(ids.error, observe); }
          try { w.chrome?.webview?.addEventListener?.("message", () => { webMessages++; notify(); }); } catch { /* best effort */ }
          try {
            post[1](JSON.stringify({
              cmd: "get_backend_config", callback: ids.callback, error: ids.error,
              options: { customProtocolIpcBlocked: true }, payload: {}, __TAURI_INVOKE_KEY__: captured.key,
            }));
            const verdict = await Promise.race([arrived.then(() => "replied"), sleep(limit).then(() => "no-reply")]);
            result.native = {
              status: verdict, via: post[0], validKeyAttempted: true, observer: held ? "callbacks" : "none",
              replies, webMessages,
            };
          } catch (error) { result.native = { status: "post-threw", via: post[0], validKeyAttempted: true, reasonType: typeof error }; }
          finally {
            if (held) for (const id of [ids.callback, ids.error]) if (map.get(id) === observe) map.delete(id);
          }
        }
        // A late answer to the invoke counts too.
        result.invokeFinal = invokeFinal;
        return result;
      }, { secret: DEV_TOKEN, limit: 800, port: SIDECAR_PORT, ids: observerIds }, { timeout: 5_000 }), 10_000, "資料フレーム内の隔離プローブ");
      mark("isolation: probe finished");
      // A reply to the main frame runs one of its observers; give it a moment to arrive, then read the booleans.
      await new Promise(resolve => setTimeout(resolve, 250));
      const seen = await bounded(page.evaluate(name => {
        const state = (window as any)[name]?.state;
        return { present: state !== undefined, reply: state?.reply === true, error: state?.error === true,
          configShaped: state?.configShaped === true, hasToken: state?.hasToken === true };
      }, observerName), 3_000, "主フレームの観測器の読み取り");
      mainFrame.observable = mainFrame.observable && seen.present;
      Object.assign(mainFrame, { reply: seen.reply, error: seen.error, configShaped: seen.configShaped, hasToken: seen.hasToken });
    } finally {
      // Unregister both observers and drop the global; best effort, so a failed probe's own error is not hidden.
      try {
        mainFrame.cleaned = await bounded(page.evaluate(name => {
          const w = window as any, internals = w.__TAURI_INTERNALS__, held = w[name];
          const unregister = internals?.unregisterCallback;
          if (held && typeof unregister === "function") for (const id of held.ids as number[]) unregister(id);
          delete w[name];
          return typeof unregister === "function" && w[name] === undefined;
        }, observerName), 3_000, "主フレームの観測器の解除");
      } catch { /* reported through mainFrame.cleaned below */ }
    }
    isolation.mainFrame = mainFrame;
    const nativeAttempted = isolation.native.validKeyAttempted === true;
    const mainQuiet = !mainFrame.reply && !mainFrame.error && !mainFrame.configShaped && !mainFrame.hasToken;
    // What the run does and does not show about the native bridge. Only "validKeyNoReply" says that a message
    // carrying the real key got no answer, in the frame or in the main frame, while the main frame's observers
    // were working and a main-origin invoke with the same backend succeeded.
    isolation.validKeyNoReply = isolation.invokeKeyObserved === true && nativeAttempted && isolation.native.status === "no-reply"
      && mainFrame.observable && mainFrame.positiveControl.configValid && mainFrame.positiveControl.tokenMatches && mainQuiet;
    mark(`isolation: keyObserved=${isolation.invokeKeyObserved} validKeyAttempted=${nativeAttempted} native=${isolation.native.status} `
      + `invoke=${isolation.invoke.status} mainReply=${mainFrame.reply} mainError=${mainFrame.error} `
      + `mainConfigShaped=${mainFrame.configShaped} mainHasToken=${mainFrame.hasToken} validKeyNoReply=${isolation.validKeyNoReply}`);
    // Nothing that carries the backend's token may be kept, whatever the probe saw.
    assert.ok(!JSON.stringify(isolation).includes(DEV_TOKEN), "プローブ結果にバックエンドのトークンが含まれています（結果は保存しません）");
    const evidence = JSON.stringify({
      api: isolation.api, invoke: isolation.invoke, invokeFinal: isolation.invokeFinal, ipcFetch: isolation.ipcFetch,
      invokeKeyObserved: isolation.invokeKeyObserved, native: isolation.native, mainFrame, validKeyNoReply: isolation.validKeyNoReply,
      bridge: isolation.bridge,
    });
    fs.writeFileSync(path.join(screenshots, "isolation.json"), JSON.stringify(isolation, null, 2));
    assert.notEqual(isolation.invoke.status, "resolved", `資料内から get_backend_config が応答しました（重大）: ${evidence}`);
    assert.notEqual(isolation.invokeFinal.state, "resolved", `資料内の get_backend_config に遅れて応答がありました（重大）: ${evidence}`);
    assert.notEqual(isolation.ipcFetch.outcome, "resolved", `資料内のIPCリクエストがCSPで止まらず応答を得ました: ${evidence}`);
    assert.ok(!["replied", "post-threw"].includes(isolation.native.status), `資料内からのネイティブメッセージが応答を得ました: ${evidence}`);
    assert.ok(!isolation.native.replies?.some((reply: { configShaped: boolean; hasSecret: boolean; hasInvokeKey: boolean }) => reply.configShaped || reply.hasSecret || reply.hasInvokeKey),
      `ネイティブ応答に設定またはトークンが含まれています: ${evidence}`);
    // "No reply" only counts where the main frame's observers are known to work and its own invoke succeeds.
    assert.equal(mainFrame.observable, true, `主フレームの観測器が働いていません（観測確認が失敗）: ${evidence}`);
    assert.deepEqual(mainFrame.positiveControl, { configValid: true, tokenMatches: true },
      `主フレーム自身の get_backend_config が有効な設定を返しませんでした（陽性対照が失敗）: ${evidence}`);
    assert.deepEqual({ reply: mainFrame.reply, error: mainFrame.error, configShaped: mainFrame.configShaped, hasToken: mainFrame.hasToken },
      { reply: false, error: false, configShaped: false, hasToken: false },
      `資料からのメッセージの応答が主フレームの観測器に届きました（重大）: ${evidence}`);
    assert.equal(mainFrame.cleaned, true, `主フレームの観測器を解除できませんでした: ${evidence}`);
    assert.equal(isolation.invoke.hasSecret ?? false, false, `invoke の値にトークンが含まれています: ${evidence}`);
    // A real fetch of a running server was refused by the document's own CSP, which is what keeps the invoke's
    // custom-protocol request, and any timeout above, from being a mere absence of a bridge.
    assert.equal(isolation.api.status, "rejected", `資料内のfetchがCSPで拒否されませんでした: ${evidence}`);
    assert.deepEqual({
      parent: isolation.parentDenied, storage: isolation.storageDenied, tokenVisible: isolation.tokenVisible,
      api: isolation.api.status === "rejected",
      ipc: ["no-bridge", "rejected", "timeout"].includes(isolation.invoke.status)
        && ["no-bridge", "key-unavailable", "no-reply"].includes(isolation.native.status),
    }, { parent: true, storage: true, tokenVisible: false, api: true, ipc: true }, evidence);
    mark("navigation: submit and external link");
    await frame().locator("#submit").click();
    await frame().locator("#navigate").click();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(externalRequests, 0, "資料から外部navigation/formが通信を発生させないこと");
    assert.ok(page.url().startsWith("http://localhost:1420"));
    mark("navigation: no external request");
    // A refused navigation can replace the frame with the browser's error page; retry restores it.
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await frame().getByRole("heading", { name: "図解サマリー", exact: true }).waitFor();
    await page.getByRole("button", { name: "大きく開く", exact: true }).click();
    await page.getByRole("button", { name: "右パネルに戻す", exact: true }).waitFor();
    await frame().getByRole("heading", { name: "図解サマリー", exact: true }).waitFor();
    const box = await page.locator("iframe").boundingBox(); assert.ok(box && box.width > 800);
    await page.screenshot({ path: path.join(screenshots, "02-html-main-script-allowed.png") });
    await page.getByRole("button", { name: "右パネルに戻す", exact: true }).click();
    mark("management: rename");
    await page.getByRole("button", { name: "資料の名前を変更", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "資料の名前を変更", exact: true });
    await rename.getByRole("textbox").fill("図解を改名.html"); await rename.getByRole("button", { name: "OK", exact: true }).click();
    await rename.waitFor({ state: "detached" });
    for (let i = 0; i < 5; i++) await api.call("POST", docs, { title: `資料${i}.html`, content: `<h1>資料${i}</h1>` });
    const memo = await api.call("POST", base, { title: "読書.md", content: "メモ本文" });
    await paper.getByLabel("持ち物 7件", { exact: true }).waitFor();
    await waitFor(async () => await selector.locator("option").count() === 6, "資料一覧がメモを除いて6件になること");
    await page.getByRole("button", { name: "資料を後ろへ", exact: true }).click();
    await waitFor(async () => (await api.call("GET", base))[1].id === first.id, "資料の順序を保存すること");
    assert.equal((await api.call("GET", base))[6].id, memo.id);
    await page.getByRole("treeitem").filter({ hasText: /^ほか 2件$/ }).click();
    const chooser = page.getByRole("dialog", { name: "持ち物", exact: true });
    await chooser.getByRole("button", { name: "🌐 資料4.html", exact: true }).click();
    assert.equal(await selector.inputValue(), (await api.call("GET", base)).find((row: { title: string }) => row.title === "資料4.html").id);
    mark("management: delete");
    await page.getByRole("button", { name: "資料を削除", exact: true }).click();
    await page.getByRole("dialog", { name: "資料を削除", exact: true }).getByRole("button", { name: "削除する", exact: true }).click();
    await paper.getByLabel("持ち物 6件", { exact: true }).waitFor();
    await page.getByRole("button", { name: "メモ", exact: true }).click();
    await page.getByRole("textbox", { name: "論文のメモ", exact: true }).waitFor();
    assert.ok((await page.getByRole("textbox", { name: "論文のメモ", exact: true }).innerText()).includes("メモ本文"));
    await page.screenshot({ path: path.join(screenshots, "03-mixed-children.png") });
    mark("done");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
