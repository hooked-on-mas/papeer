import { create } from "zustand";

/** Tokens used by one job, as the sidecar reports them. input_tokens includes cached input. */
export type Usage = {
  provider: string;
  model: string;
  calls: number;
  measured_calls: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
};

export type LimitWindow = { label: string; used_percent: number; resets_at: number | null };

/** Plan usage of the connected AI; only Claude Code, Codex and some APIs report it. */
export type UsageLimits = { provider: string; windows: LimitWindow[]; checked_at: number };

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** One line such as "入力 12k · 出力 850 トークン（AI呼び出し 3回）". */
export function usageSummary(usage: Usage): string {
  if (!usage.measured_calls) return `AI呼び出し ${usage.calls}回（トークン数はこの接続先から取得できません）`;
  let text = `入力 ${formatTokens(usage.input_tokens)} · 出力 ${formatTokens(usage.output_tokens)} トークン`;
  if (usage.calls > 1) text += `（AI呼び出し ${usage.calls}回）`;
  return text;
}

export function usageDetails(usage: Usage): string {
  const lines = [`${usage.model || usage.provider}：AI呼び出し ${usage.calls}回`];
  if (usage.measured_calls) {
    lines.push(`入力 ${usage.input_tokens.toLocaleString()} トークン（うちキャッシュ ${usage.cached_tokens.toLocaleString()}）`);
    lines.push(`出力 ${usage.output_tokens.toLocaleString()} トークン（うち思考 ${usage.reasoning_tokens.toLocaleString()}）`);
  }
  if (usage.measured_calls < usage.calls) lines.push(`${usage.calls - usage.measured_calls}回分はトークン数を取得できませんでした`);
  if (usage.cost_usd != null) lines.push(`API料金換算 $${usage.cost_usd.toFixed(3)}（サブスクリプションでは実際の請求ではありません）`);
  return lines.join("\n");
}

export function limitsSummary(limits: UsageLimits): string {
  return limits.windows.map((w) => `${w.label.replace(/枠$/, "")} ${Math.round(w.used_percent)}%`).join(" · ");
}

export function limitsDetails(limits: UsageLimits): string {
  return limits.windows.map((w) => {
    const reset = w.resets_at ? `（${new Date(w.resets_at * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} にリセット）` : "";
    return `${w.label}：${w.used_percent.toFixed(1)}% 使用${reset}`;
  }).join("\n");
}

type LastUsageState = { usage: Usage | null; kind: string | null };

/** The newest finished AI job's usage, for the status bar. */
export const useLastUsage = create<LastUsageState>(() => ({ usage: null, kind: null }));
