import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Globe, Loader2, LogIn, PlugZap, RefreshCw, SquareTerminal, XCircle } from "lucide-react";
import { cn } from "cn";
import { apiRequest } from "../../api/client";
import { PROVIDER_LABELS, type SettingsData } from "../../api/hooks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { showMessage } from "../../components/AppDialogs";
import { showError, startJob } from "../jobs/jobEvents";

type Option = { id: string; name: string };
type CliProvider = "codex" | "claude" | "gemini";

const PROVIDERS: { id: string; description: string }[] = [
  { id: "codex", description: "Codex CLI のログインで ChatGPT の利用枠を使います" },
  { id: "claude", description: "Claude Code のログイン状態と利用枠を使います" },
  { id: "gemini", description: "Antigravity CLI (agy) 経由で Gemini を使います" },
  { id: "api", description: "API キー、または Ollama などのローカルモデル" },
];
// 0 is automatic: one request at a time for a local model, three otherwise.
const CONCURRENCY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "自動（ローカルモデルは1、それ以外は3）" },
  { value: 1, label: "1（1件ずつ）" },
  ...[2, 3, 4, 6, 8].map((value) => ({ value, label: String(value) })),
];
const CLI_LABELS: Record<CliProvider, { label: string; placeholder: string }> = {
  codex: { label: "Codex のパス", placeholder: "空欄なら自動検出（codex.cmd など）" },
  claude: { label: "Claude Code のパス", placeholder: "空欄なら自動検出（claude.cmd など）" },
  gemini: { label: "agy のパス", placeholder: "空欄なら自動検出（agy.exe など）" },
};

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Form state of the 接続 section; the dialog owns it so that one 保存 covers every section. */
export function useConnectionForm(open: boolean, settings: SettingsData | undefined) {
  const [provider, setProvider] = useState("codex");
  const [cliPaths, setCliPaths] = useState<Record<CliProvider, string>>({ codex: "", claude: "", gemini: "" });
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [concurrency, setConcurrency] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open || !settings) return;
    setProvider(settings.provider || "codex");
    setCliPaths({ codex: settings.codex_path || "", claude: settings.claude_path || "", gemini: settings.gemini_path || "" });
    // Model and effort are remembered per connection while the dialog is open.
    setModels({ [settings.provider]: settings.model || "" });
    setEfforts({ [settings.provider]: settings.reasoning_effort || "" });
    setApiBase(settings.api_base || "");
    setApiKey(settings.api_key || "");
    setConcurrency(settings.translation_concurrency ?? 0);
    setDirty(false);
    setCheckResult(null);
  }, [open, settings]);

  const isApi = provider === "api";
  const cliPath = isApi ? "" : cliPaths[provider as CliProvider] ?? "";
  // Listing models runs the CLI, so wait until the path stops changing.
  const queryPath = useDebounced(cliPath, 600);
  const modelsQuery = useQuery({
    queryKey: ["models", provider, queryPath],
    queryFn: () => apiRequest<Option[]>("GET", `/api/providers/${provider}/models?cli_path=${encodeURIComponent(queryPath)}`),
    enabled: open && !!settings,
    staleTime: 5 * 60_000,
  });
  const modelOptions = modelsQuery.data ?? [];
  const model = models[provider] ?? modelOptions[0]?.id ?? "";
  const debouncedModel = useDebounced(model, 400);
  const { data: effortOptions = [] } = useQuery({
    queryKey: ["efforts", provider, debouncedModel],
    queryFn: () => apiRequest<Option[]>("GET",
      `/api/providers/${provider}/efforts?model=${encodeURIComponent(debouncedModel)}&cli_path=${encodeURIComponent(queryPath)}`),
    enabled: open && !!settings,
    staleTime: 5 * 60_000,
  });
  const chosenEffort = efforts[provider] ?? "";
  // Fall back to the first choice when the model does not offer the saved value.
  const effort = effortOptions.some((o) => o.id === chosenEffort) ? chosenEffort : (effortOptions[0]?.id ?? "");
  const hasEfforts = effortOptions.length > 1;

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setCheckResult(null);
    };
  }

  const values = () => ({
    provider,
    model: model.trim(),
    reasoning_effort: hasEfforts ? effort : "",
    api_base: apiBase.trim(),
    api_key: apiKey.trim(),
    codex_path: cliPaths.codex.trim(),
    claude_path: cliPaths.claude.trim(),
    gemini_path: cliPaths.gemini.trim(),
    translation_concurrency: concurrency,
  });

  const login = async () => {
    try {
      const result = await apiRequest<{ message: string; already?: boolean }>("POST", "/api/providers/login", values());
      await showMessage(result.already ? "ログイン状態" : "ログイン", result.message);
    } catch (error) {
      showError(error, "CLIの準備エラー");
    }
  };

  const check = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      await startJob("/api/providers/check", values(), { kind: "check", paperId: null }, (event) => {
        setChecking(false);
        if (event.status === "succeeded") setCheckResult({ ok: true, text: String(event.result) });
        else setCheckResult({ ok: false, text: event.error || "接続を確認できませんでした。" });
      });
    } catch (error) {
      setChecking(false);
      setCheckResult({ ok: false, text: (error as Error).message });
    }
  };

  return {
    provider, setProvider: edit(setProvider),
    cliPath, setCliPath: edit((path: string) => setCliPaths((prev) => ({ ...prev, [provider]: path }))),
    model, setModel: edit((value: string) => setModels((prev) => ({ ...prev, [provider]: value }))),
    effort, setEffort: edit((value: string) => setEfforts((prev) => ({ ...prev, [provider]: value }))),
    apiBase, setApiBase: edit(setApiBase),
    apiKey, setApiKey: edit(setApiKey),
    concurrency, setConcurrency: edit(setConcurrency),
    isApi, hasEfforts, effortOptions, modelOptions,
    loadingModels: modelsQuery.isFetching, refetchModels: modelsQuery.refetch,
    dirty, values, login, check, checking, checkResult,
  };
}

export type ConnectionForm = ReturnType<typeof useConnectionForm>;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-x-3">
      <label className="pt-1.5">{label}</label>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function ConnectionSection({ form }: { form: ConnectionForm }) {
  const cli = form.isApi ? null : CLI_LABELS[form.provider as CliProvider];
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="接続先" className="grid grid-cols-2 gap-2">
        {PROVIDERS.map(({ id, description }) => {
          const selected = form.provider === id;
          const Icon = id === "api" ? Globe : SquareTerminal;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => form.setProvider(id)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "border-primary bg-primary/5" : "hover:bg-muted/60",
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
              <span className="min-w-0">
                <span className="block font-medium">{PROVIDER_LABELS[id]}</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">{description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        {cli && (
          <Field label={cli.label}>
            <Input value={form.cliPath} onChange={(e) => form.setCliPath(e.target.value)} placeholder={cli.placeholder} />
          </Field>
        )}
        {form.isApi && (
          <>
            <Field label="API URL" hint="ローカル例: http://localhost:11434/v1（Ollama）">
              <Input value={form.apiBase} onChange={(e) => form.setApiBase(e.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label="API キー" hint="保存されず、アプリの終了時に破棄されます。環境変数 PAPERDESK_API_KEY でも指定できます。">
              <Input type="password" value={form.apiKey} onChange={(e) => form.setApiKey(e.target.value)} autoComplete="off" />
            </Field>
          </>
        )}
        <Field label="モデル">
          <div className="flex gap-2">
            {form.isApi ? (
              <Input value={form.model} onChange={(e) => form.setModel(e.target.value)} placeholder="モデル名" />
            ) : (
              <NativeSelect
                aria-label="モデル"
                value={form.modelOptions.some((m) => m.id === form.model) ? form.model : ""}
                onChange={(e) => form.setModel(e.target.value)}
              >
                <option value="">{form.loadingModels ? "取得中…" : "モデル名を直接入力"}</option>
                {form.modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </NativeSelect>
            )}
            <Button variant="outline" onClick={() => form.refetchModels()} disabled={form.loadingModels} title="モデル一覧を再取得">
              <RefreshCw className={cn(form.loadingModels && "animate-spin")} />
              再取得
            </Button>
          </div>
          {!form.isApi && !form.modelOptions.some((m) => m.id === form.model) && (
            <Input
              aria-label="モデル名を直接入力"
              value={form.model}
              onChange={(e) => form.setModel(e.target.value)}
              placeholder="モデル名"
            />
          )}
        </Field>
        {form.hasEfforts && (
          <Field label="推論の強さ" hint="上げるほど時間とトークンが増えることがあります。翻訳済みの部分はそのまま再利用します。">
            <NativeSelect value={form.effort} onChange={(e) => form.setEffort(e.target.value)}>
              {form.effortOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </NativeSelect>
          </Field>
        )}
        <Field label="翻訳の同時実行" hint="翻訳リクエストをまとめて送ると速くなりますが、短時間に利用枠を多く使います。制限に当たるときは減らしてください。">
          <NativeSelect value={form.concurrency} onChange={(e) => form.setConcurrency(Number(e.target.value))}>
            {CONCURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </NativeSelect>
        </Field>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          {!form.isApi && (
            <Button variant="outline" onClick={form.login}>
              <LogIn /> ログイン
            </Button>
          )}
          <Button variant="outline" onClick={form.check} disabled={form.checking}>
            {form.checking ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {form.checking ? "確認中…" : "接続を確認"}
          </Button>
          <span className="text-[12px] text-muted-foreground">入力中の内容で確認します（保存はされません）</span>
        </div>
        {form.checkResult && (
          <p className={cn("flex items-start gap-1.5 text-[12px] whitespace-pre-wrap",
            form.checkResult.ok ? "text-success" : "text-destructive")}>
            {form.checkResult.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
            {form.checkResult.text}
          </p>
        )}
      </div>

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {form.isApi
          ? "翻訳・解説・質問を実行すると、対象テキストがこの API へ送られます。接続先によっては従量課金になります。"
          : "翻訳・解説・質問を実行すると、対象テキストがこの CLI へ送られます。実行できるかどうかは各ツールのログイン状態と利用枠に従います。"}
      </p>
    </div>
  );
}
