import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_JOB_KINDS, enqueueReport, errorAdvice, errorCause, firstLine, reportDetails, type ErrorReport,
} from "../src/lib/errorReports.ts";
import { AI_PLAN_JOBS } from "../src/features/jobs/jobKinds.ts";

// The lead every CLI failure starts with (papeer/providers/common.py, cli_failure).
const cli = (tool: string, detail: string) => `${tool}接続に失敗しました。ログイン状態・利用枠を確認してください。\n${detail}`;

test("a CLI failure is judged by what the CLI printed, not by its fixed lead", () => {
  assert.equal(errorCause(cli("Claude Code", "Claude AI usage limit reached|1759000000")), "quota");
  assert.equal(errorCause(cli("Codex", "You've hit your usage limit. Upgrade to Pro")), "quota");
  assert.equal(errorCause(cli("Antigravity", "RESOURCE_EXHAUSTED: Quota exceeded")), "quota");
  assert.equal(errorCause(cli("Claude Code", "Invalid API key · Please run /login")), "login");
  assert.equal(errorCause(cli("Codex", "Not logged in")), "login");
  assert.equal(errorCause(cli("Codex", "error: unexpected argument '--foo' found")), "settings");
  assert.equal(errorCause(cli("Claude Code", "model: claude-x not found")), "settings");
  assert.equal(errorCause(cli("Claude Code", "API Error: 529 Overloaded")), "network");
  assert.equal(errorCause(cli("Codex", "stream disconnected before completion")), "network");
  // Nothing recognisable after the lead: both causes it names stay possible.
  assert.equal(errorCause(cli("Claude Code", "exit status 1")), "connection");
  assert.equal(errorCause(cli("Claude Code", "")), "connection");
});

test("the stream-json keys Claude Code always prints do not read as a usage limit", () => {
  const events = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}\n{"type":"result","usage":{"output_tokens":0}}';
  assert.equal(errorCause(cli("Claude Code", events)), "connection");
  const overage = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","overageStatus":"rejected",'
    + '"overageDisabledReason":"out_of_credits","isUsingOverage":false}}\n{"type":"result","is_error":true,"result":"x"}';
  assert.equal(errorCause(cli("Claude Code", overage)), "connection");
});

test("document words echoed in a CLI failure do not decide the cause", () => {
  assert.equal(errorCause(cli("Codex", "…信用リスク(credit risk)モデルを訳すと… exit 1")), "connection");
  assert.equal(errorCause(cli("Codex", "認証 (authentication) プロトコル… exit 1")), "connection");
});

test("errors outside the AI keep their own words, whatever English they hold", () => {
  const permission = "[Errno 13] Permission denied: 'C:/Users/x/translated.pdf'";
  assert.equal(errorCause(permission), "other");
  assert.equal(errorCause(permission, "translate"), "other");
  assert.equal(errorCause("[WinError 5] アクセスが拒否されました。: 'C:/x'"), "other");
  assert.equal(errorCause("insufficient disk space"), "other");
  assert.equal(errorCause("insufficient disk space", "export"), "other");
  assert.equal(errorCause("error: file C:/papers/code 400 not found", "import"), "other");
  assert.equal(errorCause("Failed to fetch"), "other");
  // A sync that could not write its folder is not a sign-in problem, and shows its own first line.
  const sync = errorAdvice("[Errno 13] Permission denied: 'G:/マイドライブ/Papeer/library.json'", { kind: "drive-sync" });
  assert.equal(sync.cause, "other");
  assert.match(sync.summary, /^\[Errno 13\] Permission denied/);
  assert.equal(sync.settingsSection, "drive");
  // An AI job's error is read for the AI causes, as is an AI connection's message from anywhere (a showError).
  assert.equal(errorCause("Request failed: 401 Unauthorized", "ask"), "login");
  assert.equal(errorCause("Request failed: 401 Unauthorized"), "other");
  assert.equal(errorCause("Request failed: 401 Unauthorized", "drive-sync"), "other");
});

test("the AI jobs are the ones that use the plan", () => {
  assert.deepEqual([...AI_JOB_KINDS].sort(), [...AI_PLAN_JOBS].sort());
});

test("the API connection's messages", () => {
  assert.equal(errorCause("APIエラー HTTP 401。URL・モデル名・認証・利用枠を確認してください。"), "login");
  assert.equal(errorCause("APIエラー HTTP 403。URL・モデル名・認証・利用枠を確認してください。"), "login");
  assert.equal(errorCause("APIエラー HTTP 429。URL・モデル名・認証・利用枠を確認してください。"), "quota");
  assert.equal(errorCause("APIエラー HTTP 400。URL・モデル名・認証・利用枠を確認してください。 このモデル・接続先が指定effortに対応するか確認し、非対応なら「既定値」に戻してください。"), "settings");
  assert.equal(errorCause("APIエラー HTTP 404。URL・モデル名・認証・利用枠を確認してください。"), "settings");
  assert.equal(errorCause("APIエラー HTTP 503。URL・モデル名・認証・利用枠を確認してください。"), "network");
  assert.equal(errorCause("APIに接続できません。URLとネットワークを確認してください。"), "network");
  assert.equal(errorCause("APIの応答がタイムアウトしました。"), "network");
  assert.equal(errorCause("Codexの応答がタイムアウトしました。途中結果は保存されています。"), "network");
  assert.equal(errorCause("API接続ではモデル名を設定してください。"), "settings");
  assert.equal(errorCause("AIの回答が出力上限で途切れました。モデル設定を変更して再試行してください。"), "answer");
  assert.equal(errorCause("未ログインです。「ログイン」を実行してください。"), "login");
  assert.equal(errorCause("AIの応答から指定した形式のJSONを取り出せませんでした。"), "answer");
  assert.equal(errorCause("codex.cmd は cmd.exe を経由するため使いません。Codexの実行ファイル(.exe)、またはnpm版とNode.jsが必要です。"), "settings");
  assert.equal(errorCause("Codex は Node.js で動くため node が必要ですが、見つかりません（/usr/local/bin/codex）。"), "settings");
  assert.equal(errorCause("Antigravity (agy)の応答を読み取れませんでした。agy を更新してください。\n{}"), "settings");
  // A configured CLI path that names no file (papeer/providers/common.py, find_cli), from any job or the check.
  const missing = "Codex の実行ファイルが見つかりません（C:\\nope\\codex.cmd）。設定の接続先で、パスを確かめてください。";
  assert.equal(errorCause(missing), "settings");
  assert.equal(errorCause(missing, "check"), "settings");
  assert.equal(errorAdvice(missing).primary, "settings");
});

test("Codex's warning about a model's metadata does not read as a wrong model", () => {
  assert.equal(errorCause(cli("Codex", "Model metadata for `gpt-x` not found. Defaulting to fallback metadata\nstream disconnected")), "network");
});

test("a CLI that exits without saying why is told so, with neither cause decided", () => {
  // papeer/providers/common.py cli_exit_failure: the fixed words, never the answer the CLI printed.
  assert.equal(errorCause(cli("Codex", "Codexがエラー内容を出さずに終了しました（終了コード 1）。"), "translate"), "connection");
  assert.equal(errorCause(cli("Claude Code", "Claude Codeがエラー内容を出さずに終了しました（終了コード 3221225477）。")), "connection");
});

test("the app's own messages", () => {
  assert.equal(errorCause("バックエンドに接続できませんでした。"), "backend");
  assert.equal(errorCause("処理を中止しました。完了した翻訳は次回再利用できます。"), "cancelled");
  assert.equal(errorCause("この論文（abc）の処理がすでに実行中です。"), "busy");
  assert.equal(errorCause("p.3 / b12：再翻訳の上限（初回を除き2回）に達したためスキップします。"), "answer");
  assert.equal(errorCause("翻訳対象の文字が見つかりませんでした。"), "other");
  assert.equal(errorCause(""), "other");
});

test("advice: what the dialog offers for each cause", () => {
  assert.deepEqual(errorAdvice(cli("Codex", "Not logged in"), { canResume: true }).actions, ["settings", "copy"]);
  assert.deepEqual(errorAdvice(cli("Codex", "usage limit"), { canResume: true }).actions, ["settings", "resume", "copy"]);
  assert.deepEqual(errorAdvice("APIの応答がタイムアウトしました。", { canResume: true }).actions, ["resume", "copy"]);
  assert.deepEqual(errorAdvice(cli("Claude Code", "exit 1"), { canResume: true }).actions, ["settings", "resume", "copy"]);
  // No 再開 unless the failed work can start again.
  assert.deepEqual(errorAdvice("APIの応答がタイムアウトしました。").actions, ["copy"]);
  assert.equal(errorAdvice(cli("Codex", "Not logged in")).settingsSection, "connection");
});

test("advice: 再開 is the main button only where starting again may pass", () => {
  assert.equal(errorAdvice(cli("Codex", "usage limit"), { canResume: true }).primary, "settings");
  assert.equal(errorAdvice("この論文（abc）の処理がすでに実行中です。", { canResume: true }).primary, null);
  assert.equal(errorAdvice("APIの応答がタイムアウトしました。", { canResume: true }).primary, "resume");
  assert.equal(errorAdvice("APIの応答がタイムアウトしました。").primary, null);
  assert.equal(errorAdvice(cli("Codex", "Not logged in")).primary, "settings");
});

test("advice: a failed sync or backup opens its own settings page", () => {
  const sync = errorAdvice("同期フォルダーに書き込めませんでした。", { kind: "drive-sync" });
  assert.equal(sync.settingsSection, "drive");
  assert.deepEqual(sync.actions, ["settings", "copy"]);
  assert.equal(errorAdvice("容量が足りません", { kind: "restore" }).settingsSection, "backup");
});

test("advice: an unknown error is summarised by its first line", () => {
  assert.equal(errorAdvice("\n  翻訳対象の文字が見つかりませんでした。\nTraceback ...").summary, "翻訳対象の文字が見つかりませんでした。");
  assert.equal(errorAdvice("").summary, "原因不明のエラーが発生しました。");
  assert.match(errorAdvice(cli("Codex", "usage limit")).summary, /利用枠/);
});

test("firstLine cuts a long line", () => {
  assert.equal(firstLine("a".repeat(200), 10), "a".repeat(9) + "…");
  assert.equal(firstLine("  \n\n x \n y"), "x");
});

const report = (over: Partial<ErrorReport>): ErrorReport => ({ id: "1", title: "t", message: "m", at: 0, ...over });

test("errors wait in turn and the same error is not queued twice", () => {
  let queue = enqueueReport([], report({ id: "a", jobId: "j1", message: "one" }));
  queue = enqueueReport(queue, report({ id: "b", jobId: "j2", message: "two" }));
  assert.deepEqual(queue.map((r) => r.id), ["a", "b"]);
  // The same job again, or the same text for the same paper.
  assert.equal(enqueueReport(queue, report({ id: "c", jobId: "j1", message: "other" })).length, 2);
  assert.equal(enqueueReport(queue, report({ id: "d", message: "two", jobId: undefined })).length, 2);
  assert.equal(enqueueReport(queue, report({ id: "d", message: "three", jobId: undefined })).length, 3);
  assert.equal(enqueueReport([report({ id: "e" })], report({ id: "f" })).length, 1);
  // The same failure from the job and from the caller that waited for it, under other titles.
  assert.equal(enqueueReport([report({ id: "e", title: "同期を完了できませんでした" })], report({ id: "f", title: "同期できませんでした" })).length, 1);
  assert.equal(enqueueReport([report({ id: "e", paperId: "p1" })], report({ id: "f", paperId: "p2" })).length, 2);
});

test("a job's report takes the place of the same failure its caller reported first", () => {
  const caller = report({ id: "c", title: "同期できませんでした", message: "boom" });
  const job = report({ id: "j", title: "同期を完了できませんでした", message: "boom", jobId: "job-1", kind: "drive-sync" });
  const queue = enqueueReport([caller], job);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].id, "c");
  assert.equal(queue[0].jobId, "job-1");
  assert.equal(queue[0].title, "同期を完了できませんでした");
  // The caller's report after the job's changes nothing.
  assert.deepEqual(enqueueReport([job], caller), [job]);
});

test("beyond the limit the oldest waiting errors go, never the one on screen", () => {
  let queue: ErrorReport[] = [];
  for (let i = 0; i < 6; i++) queue = enqueueReport(queue, report({ id: String(i), message: String(i) }), 4);
  assert.deepEqual(queue.map((r) => r.id), ["0", "3", "4", "5"]);
});

test("the copied details name the paper, the job and the raw message", () => {
  const r = report({ title: "翻訳を完了できませんでした", paperTitle: "Smith (2020) Paper", kind: "translate", jobId: "j9", message: "raw\nline" });
  const text = reportDetails(r, errorAdvice(r.message));
  assert.match(text, /^翻訳を完了できませんでした\n論文: Smith \(2020\) Paper\n処理: translate \(j9\)\n日時: /);
  assert.ok(text.endsWith("\n\nraw\nline"));
  assert.ok(!reportDetails(report({}), errorAdvice("m")).includes("論文:"));
});
