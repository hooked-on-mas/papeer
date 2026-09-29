/**
 * How an error is told to the user: a one-line summary and what can be done about it, judged from
 * the text the sidecar sends (job.finished's error, an API error's detail). Kept free of React and
 * the stores so that tests/errorReports.test.ts can check the rules.
 *
 * The sidecar reports failures as plain text. The AI connections (papeer/providers) start a CLI
 * failure with 「<ツール>接続に失敗しました。ログイン状態・利用枠を確認してください。」 and add what the
 * CLI printed, often in English ("usage limit", "not logged in"); the API connection reports
 * 「APIエラー HTTP <code>。…」 or 「APIに接続できません。…」. The patterns below follow the ones the
 * providers use to decide what not to send again (_CLI_FAILURE_CAUSES, _TEMPORARY_CLI_FAILURE), so
 * the fixed Japanese lead of a CLI failure alone never decides the cause.
 */
import type { SettingsSection } from "@/features/settings/settingsNavigation";

export type ErrorCause =
  | "login" // Not signed in, a wrong API key, or no permission.
  | "quota" // The plan's usage limit or credit is used up, or the plan or seat does not include the use.
  | "settings" // The connection's model, URL, options or CLI path are wrong.
  | "network" // A timeout, a lost connection or a server error; trying again later may pass.
  | "connection" // An AI connection failed without saying why (login or usage limit).
  | "answer" // The AI answered with nothing usable (cut off, empty, wrong format, retry limit).
  | "busy" // Another job holds the paper or the library.
  | "backend" // The app's own sidecar could not be reached.
  | "cancelled"
  | "other";

export type ErrorAction = "settings" | "resume" | "copy";

export type ErrorAdvice = {
  cause: ErrorCause;
  /** One line for the user; the raw text stays available as details. */
  summary: string;
  /** In the order the dialog shows them. */
  actions: ErrorAction[];
  /** The main button; null: 閉じる is. */
  primary: ErrorAction | null;
  settingsSection: SettingsSection;
};

/** An error waiting in, or shown by, the error dialog. */
export type ErrorReport = {
  id: string;
  title: string;
  /** The raw error text, shown as details and copied. */
  message: string;
  paperId?: string | null;
  paperTitle?: string | null;
  /** The job kind, when a job failed. */
  kind?: string;
  jobId?: string;
  /** Starts the failed work again (the job's feature decides how); absent when it cannot. */
  resume?: { label: string; run: () => void };
  /** Date.now() when the error came. */
  at: number;
};

const LOGIN = new RegExp([
  "未ログイン", "ログインしていません", "api ?キー(?:が|を)(?:未設定|設定してください|不正)",
  "not (?:logged|signed) in", "log ?in (?:required|again)", "please (?:run )?(?:/login|log ?in|sign in)",
  "unauthori[sz]ed", "authentication(?:_error| failed| error| required)", "failed to authenticate", "not authenticated",
  "invalid (?:api[ _-]?key|token|credential)", "(?:token|session|credentials?) (?:has )?expired", "forbidden",
  "(?:status|http|code|error)\\W{0,3}40[13]\\b", "sign in again",
  // Codex: a sign-in it cannot renew, or none at all. Not "Failed to refresh token: <network error>",
  // which passes; the lasting ones all say "could not be refreshed".
  "could not be refreshed", "no (?:\\w+ )?credentials? (?:were |was )?found",
  // Claude Code's error codes for it (the "error" of its events).
  "authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error",
].join("|"), "i");

const QUOTA = new RegExp([
  "利用枠を使い切", "利用上限に達", "usage limit", "(?:hit|reached) your (?:[\\w'\\u2019-]+ ){0,3}limit",
  "(?:weekly|daily|monthly|session|hourly|5-hour|five-hour) limit", "limit (?:reached|exceeded)", "quota",
  "resource.?exhausted", "credit balance", "out of credits", "insufficient (?:credits?|funds|balance|quota)",
  "billing (?:hard )?limit", "billing (?:issue|error|required)", "payment required", "rate.?limit(?:ed| reached| exceeded)",
  "(?:status|http|code|error)\\W{0,3}429\\b",
  // Claude Code's usage credits, spend limits and team budgets; a plan or seat without the usage.
  "usage credit", "spend limit", "shared budget", "out of (?:extra )?usage", "seat type (?:does not|doesn.?t) include",
  "usage allocation", "usage not included", "billing_error",
].join("|"), "i");

const SETTINGS = new RegExp([
  "モデル名を設定", "api url", "不明な接続先", "実行ファイル\\(\\.exe\\)", "の実行ファイルが見つかりません",
  "node が必要ですが、見つかりません",
  "agy を更新してください",
  "provided but not defined", "unknown (?:option|flag|argument|command|model)", "unrecognized",
  "unexpected argument", "invalid (?:model|value|argument|option)",
  // Not Codex's warning "Model metadata for `x` not found", printed for models it runs anyway.
  "model\\b(?! metadata)[^\\n]{0,60}\\b(?:not found|does not exist|may not exist|not supported|not available|unavailable)",
  "not (?:a )?(?:valid|supported) model", "issue with the selected model", "invalid_request", "model_not_found", "(?:status|http|code|error)\\W{0,3}40[04]\\b",
].join("|"), "i");

const NETWORK = new RegExp([
  "タイムアウト", "apiに接続できません", "接続が途中で切れ", "安全な接続を確立できません",
  "api error\\W{0,3}(?:5\\d\\d|529)\\b", "(?:status|http|code|error)\\W{0,3}5\\d\\d\\b", "overloaded",
  "internal server error", "bad gateway", "gateway time-?out", "service unavailable", "temporarily unavailable",
  "deadline.?exceeded", "econnreset", "econnrefused", "econnaborted", "etimedout", "epipe", "socket hang up",
  "fetch failed", "connection (?:reset|refused|closed|error|lost)", "network (?:error|is unreachable)",
  "stream disconnected", "timed out", "timeout", "error sending request", "server_error",
].join("|"), "i");

const ANSWER = /回答が空|出力上限で途切れ|指定した形式のjsonを取り出せません|回答ファイルが返り|テキストの回答が返り|回答を使えません|応答形式が不正|jsonオブジェクトではありません|再翻訳の上限|翻訳の一部が欠落/i;
const BUSY = /すでに実行中|バックアップ・復元が実行中|終わってから|終わるまでお待ちください|library_busy/i;
// The fixed lead of every CLI failure (papeer/providers/common.py, cli_failure).
const CLI_FAILURE = /接続に失敗しました。ログイン状態・利用枠を確認してください/;
// Messages only the AI connections and the translation of their answers give (papeer/providers,
// papeer/translation): with one of them, the text is about the AI whichever job reported it.
const AI_MESSAGE = new RegExp([
  "^APIエラー HTTP \\d", "APIに接続できません", "APIの応答がタイムアウト", "APIとの接続が途中で切れ", "APIとの安全な接続",
  "の応答がタイムアウトしました", "未ログインです", "API接続ではモデル名を設定", "^API URL", "不明な接続先です",
  "の実行ファイル\\(\\.exe\\)", "の実行ファイルが見つかりません", "node が必要ですが、見つかりません", "の回答が空でした", "出力上限で途切れ", "から回答ファイルが返り", "テキストの回答が返り",
  "の回答を使えませんでした", "応答形式が不正", "JSONオブジェクトではありません", "再翻訳の上限", "翻訳の一部が欠落",
  "指定した形式のJSONを取り出せません", "agy を更新してください",
].join("|"), "m");
// A Python OSError ([Errno 13] Permission denied, [WinError 5] ...): the app's own files, never the AI.
const OS_ERROR = /^\[(?:Errno|WinError) -?\d+\]/;
// Claude Code's stream-json status events: always printed, with keys such as "out_of_credits" that
// do not mean the run failed on them.
const STATUS_EVENT = /^\s*\{.*"type"\s*:\s*"(?:rate_limit_event|system)".*$/gm;

/**
 * Jobs that call the AI; the same list as AI_PLAN_JOBS (features/jobs/jobKinds.ts, checked by
 * tests/errorReports.test.ts), kept here so that this file imports nothing at run time.
 */
export const AI_JOB_KINDS: readonly string[] = ["translate", "revision", "revision-draft", "glossary-draft", "article", "ask", "check"];

const SUMMARIES: Record<Exclude<ErrorCause, "other">, string> = {
  login: "AIサービスにログインしていないか、APIキー・権限が正しくありません。",
  quota: "AIサービスの利用枠を使い切ったか、プランや一時的な制限により利用できません。",
  settings: "AI接続の設定（モデル・URL・CLIのオプション）を受け付けられませんでした。",
  network: "AIサービスとの通信に失敗しました。時間をおいて再開してください。",
  connection: "AI接続に失敗しました。ログイン状態と利用枠を確認してください。",
  answer: "AIの回答を使えませんでした。再開するか、モデルを変えて試してください。",
  busy: "ほかの処理が実行中のため開始できませんでした。終わってからやり直してください。",
  backend: "アプリの処理部（sidecar）に接続できませんでした。再接続を待ってからやり直してください。",
  cancelled: "処理を中止しました。",
};

const ACTIONS: Record<ErrorCause, ErrorAction[]> = {
  login: ["settings", "copy"],
  // Starting again right away fails the same way, or waits on the other job: 再開 is never the main button.
  quota: ["settings", "resume", "copy"],
  settings: ["settings", "copy"],
  network: ["resume", "copy"],
  connection: ["settings", "resume", "copy"],
  answer: ["resume", "settings", "copy"],
  busy: ["copy", "resume"],
  backend: ["copy"],
  cancelled: ["resume", "copy"],
  other: ["resume", "copy"],
};

const NO_RESUME_FIRST: readonly ErrorCause[] = ["quota", "busy"];

/** Jobs whose failures are fixed in their own settings page rather than the AI connection. */
const SECTION_OF_KIND: Record<string, SettingsSection> = { "drive-sync": "drive", backup: "backup", restore: "backup", "ocr-data": "ocr" };

/** The first non-empty line, cut to `limit` characters. */
export function firstLine(message: string, limit = 140): string {
  const line = message.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

/**
 * The cause of an error; `kind` is the job that failed, if any. The AI causes are considered only for
 * an AI job or a text the AI connections give (a CLI failure, 「APIエラー HTTP …」, AI_MESSAGE):
 * a sync, backup, import or export, and an error of the UI itself, keep their own words ("other"),
 * so that a "Permission denied" on a file never reads as a sign-in problem.
 */
export function errorCause(message: string, kind?: string): ErrorCause {
  const text = message.trim();
  if (!text) return "other";
  if (text === "バックエンドに接続できませんでした。") return "backend";
  if (/^[^\n]*を中止しました/.test(text)) return "cancelled";
  if (BUSY.test(text)) return "busy";
  if (OS_ERROR.test(text)) return "other";
  const cliFailure = CLI_FAILURE.test(text);
  if (!cliFailure && !AI_MESSAGE.test(text) && !(kind && AI_JOB_KINDS.includes(kind))) return "other";
  // A CLI failure is judged by what the CLI printed after the fixed lead, which names both causes.
  const detail = (cliFailure ? text.replace(CLI_FAILURE, "") : text).replace(STATUS_EVENT, "");
  if (QUOTA.test(detail)) return "quota";
  if (LOGIN.test(detail)) return "login";
  if (SETTINGS.test(detail)) return "settings";
  if (NETWORK.test(detail)) return "network";
  if (ANSWER.test(detail)) return "answer";
  if (cliFailure) return "connection";
  return "other";
}

/**
 * What to tell and offer for an error. `canResume`: the failed work has a way to start again
 * (a job whose feature registered one); without it the dialog offers no 再開.
 */
export function errorAdvice(message: string, { kind, canResume = false }: { kind?: string; canResume?: boolean } = {}): ErrorAdvice {
  const cause = errorCause(message, kind);
  const kindSection = kind ? SECTION_OF_KIND[kind] : undefined;
  let actions = ACTIONS[cause].filter((action) => action !== "resume" || canResume);
  // A failed sync or backup is looked into on its own page, whatever the cause.
  if (kindSection && !actions.includes("settings")) actions = ["settings", ...actions];
  return {
    cause,
    summary: cause === "other" ? firstLine(message) || "原因不明のエラーが発生しました。" : SUMMARIES[cause],
    actions,
    primary: actions.find((action) => action !== "copy" && !(action === "resume" && NO_RESUME_FIRST.includes(cause))) ?? null,
    settingsSection: kindSection ?? "connection",
  };
}

/**
 * Add a report to the waiting ones, unless the same error is already waiting: the same job, or the
 * same text for the same paper whatever the title (a failed job and the caller that waited for it,
 * like a manual sync, report one failure). A job's report, which knows more, takes the place of the
 * caller's.
 */
export function enqueueReport(queue: readonly ErrorReport[], report: ErrorReport, limit = 20): ErrorReport[] {
  const index = queue.findIndex((r) => (report.jobId && r.jobId === report.jobId)
    || (r.message === report.message && (r.paperId ?? null) === (report.paperId ?? null)));
  if (index >= 0) {
    const waiting = queue[index];
    return report.jobId && !waiting.jobId ? queue.map((r, i) => (i === index ? { ...report, id: waiting.id } : r)) : [...queue];
  }
  // Beyond the limit the oldest waiting ones go; the one on screen (the first) stays.
  const next = [...queue, report];
  return next.length > limit ? [next[0], ...next.slice(next.length - limit + 1)] : next;
}

/** The text 詳細をコピー puts on the clipboard. */
export function reportDetails(report: ErrorReport, advice: ErrorAdvice): string {
  return [
    report.title,
    report.paperTitle ? `論文: ${report.paperTitle}` : "",
    report.kind ? `処理: ${report.kind}${report.jobId ? ` (${report.jobId})` : ""}` : "",
    `日時: ${new Date(report.at).toLocaleString("ja-JP")}`,
    `要約: ${advice.summary}`,
    "",
    report.message,
  ].filter((line, index) => line || index >= 5).join("\n");
}
