import { useEffect, useId, useState } from "react";
import { CheckCircle2, Globe, Loader2, LogIn, PlugZap, RefreshCw, SquareTerminal, XCircle } from "lucide-react";
import { cn } from "cn";
import { api, unwrap } from "../../api/client";
import {
  useProviderEfforts, useProviderModels, useProviders,
  type ProviderOptions, type ProviderSpec, type SettingsData,
} from "../../api/hooks";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { showMessage } from "../../components/AppDialogs";
import { startJob } from "../jobs/jobEvents";
import { showError } from "@/components/errorDialog";

// 0 is automatic: one request at a time for a local model, three otherwise.
const CONCURRENCY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "自動（ローカルモデルは1、それ以外は3）" },
  { value: 1, label: "1（1件ずつ）" },
  ...[2, 3, 4, 6, 8].map((value) => ({ value, label: String(value) })),
];

type CheckResult = { ok: boolean; text: string } | null;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function trimmed(options: ProviderOptions): ProviderOptions {
  return Object.fromEntries(Object.entries(options).map(([id, values]) =>
    [id, Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]))]));
}

/** Form state of the 接続 section; the dialog owns it so that one 保存 covers every section. */
export function useConnectionForm(open: boolean, settings: SettingsData | undefined) {
  const { data: providers = [] } = useProviders();
  const [provider, setProvider] = useState("codex");
  // Per connection: its fields (cli_path, base_url) and the model/effort chosen for it.
  const [options, setOptions] = useState<ProviderOptions>({});
  const [apiKey, setApiKey] = useState("");
  const [concurrency, setConcurrency] = useState(0);
  const [metadataAi, setMetadataAi] = useState(false);
  const [metadataProvider, setMetadataProvider] = useState("");
  const [dirty, setDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult>(null);
  const [metadataChecking, setMetadataChecking] = useState(false);
  const [metadataCheckResult, setMetadataCheckResult] = useState<CheckResult>(null);

  useEffect(() => {
    if (!open || !settings) return;
    setProvider(settings.provider || "codex");
    const initial = {
      ...settings.provider_options,
      [settings.provider]: {
        ...settings.provider_options?.[settings.provider],
        model: settings.model || "",
        reasoning_effort: settings.reasoning_effort || "",
      },
    };
    const lookupProvider = settings.paper_metadata_provider || settings.provider;
    initial[lookupProvider] = { ...initial[lookupProvider], paper_metadata_model: settings.paper_metadata_model || "" };
    setOptions(initial);
    setApiKey(settings.api_key || "");
    setConcurrency(settings.translation_concurrency ?? 0);
    setMetadataAi(settings.paper_metadata_ai_enabled === true);
    setMetadataProvider(settings.paper_metadata_provider || "");
    setDirty(false);
    setCheckResult(null);
    setMetadataCheckResult(null);
  }, [open, settings]);

  const spec: ProviderSpec | undefined = providers.find((p) => p.id === provider);
  const current = options[provider] ?? {};
  const option = (key: string) => current[key] ?? "";
  const isCli = spec?.kind === "cli";
  // Listing models runs the CLI, so wait until the path stops changing.
  const queryPath = useDebounced(isCli ? option("cli_path") : undefined, 600);
  const modelsQuery = useProviderModels(provider, { cliPath: queryPath, enabled: open && !!settings });
  const modelOptions = modelsQuery.data ?? [];
  const model = current.model ?? modelOptions[0]?.id ?? "";
  const debouncedModel = useDebounced(model, 400);
  const { data: effortOptions = [] } = useProviderEfforts(provider, debouncedModel,
    { cliPath: queryPath, enabled: open && !!settings });
  const chosenEffort = option("reasoning_effort");
  const lookupProvider = metadataProvider || provider;
  const metadataSpec = providers.find(p => p.id === lookupProvider);
  const metadataOption = (key: string) => options[lookupProvider]?.[key] ?? "";
  const metadataModel = metadataOption("paper_metadata_model");
  const metadataPath = useDebounced(metadataSpec?.kind === "cli" ? metadataOption("cli_path") : undefined, 600);
  const metadataModelsQuery = useProviderModels(lookupProvider,
    { cliPath: metadataPath, enabled: open && !!settings && metadataAi });
  const metadataFallbackModel = lookupProvider === provider ? model : metadataOption("model");
  // Fall back to the first choice when the model does not offer the saved value.
  const effort = effortOptions.some((o) => o.id === chosenEffort) ? chosenEffort : (effortOptions[0]?.id ?? "");
  const hasEfforts = effortOptions.length > 1;

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
      setCheckResult(null);
      setMetadataCheckResult(null);
    };
  }
  const setProviderOption = (id: string, key: string) => edit((value: string) =>
    setOptions((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } })));
  const setOption = (key: string) => setProviderOption(provider, key);
  const setMetadataOption = (key: string) => setProviderOption(lookupProvider, key);

  const values = () => ({
    provider,
    model: model.trim(),
    reasoning_effort: hasEfforts ? effort : "",
    timeout_seconds: settings?.timeout_seconds ?? 900,
    translation_concurrency: concurrency,
    paper_metadata_ai_enabled: metadataAi,
    paper_metadata_provider: metadataProvider,
    paper_metadata_model: metadataModel.trim(),
    // Each connection's fields plus the model/effort chosen for it, so switching back restores them.
    provider_options: trimmed({ ...options, [provider]: { ...options[provider], model, reasoning_effort: hasEfforts ? effort : "" } }),
    api_key: apiKey.trim(),
  });

  const metadataValues = () => ({ ...values(), provider: lookupProvider,
    model: metadataModel.trim() || metadataFallbackModel.trim(),
    reasoning_effort: lookupProvider === provider && !metadataModel.trim() ? values().reasoning_effort : "" });

  const login = async (information = false) => {
    try {
      const result = await unwrap(api.POST("/api/providers/login", { body: information ? metadataValues() : values() })) as { message: string; already?: boolean };
      await showMessage(result.already ? "ログイン状態" : "ログイン", result.message);
    } catch (error) {
      showError(error, "CLIの準備エラー");
    }
  };

  const check = async (information = false) => {
    const setBusy = information ? setMetadataChecking : setChecking;
    const setResult = information ? setMetadataCheckResult : setCheckResult;
    setBusy(true);
    setResult(null);
    try {
      await startJob("/api/providers/check", information ? metadataValues() : values(), { kind: "check", paperId: null }, (event) => {
        setBusy(false);
        if (event.status === "succeeded") setResult({ ok: true, text: event.result });
        else setResult({ ok: false, text: event.error || "接続を確認できませんでした。" });
      });
    } catch (error) {
      setBusy(false);
      setResult({ ok: false, text: (error as Error).message });
    }
  };

  return {
    providers, spec, provider, setProvider: edit(setProvider),
    option, setOption,
    model, setModel: setOption("model"),
    effort, setEffort: setOption("reasoning_effort"),
    apiKey, setApiKey: edit(setApiKey),
    concurrency, setConcurrency: edit(setConcurrency),
    metadataAi, setMetadataAi: edit(setMetadataAi),
    metadataProvider, setMetadataProvider: edit(setMetadataProvider), metadataSpec,
    metadataOption, setMetadataOption, metadataFallbackModel,
    metadataModel, setMetadataModel: setMetadataOption("paper_metadata_model"),
    metadataModelOptions: metadataModelsQuery.data ?? [],
    hasEfforts, effortOptions, modelOptions,
    loadingModels: modelsQuery.isFetching, refetchModels: modelsQuery.refetch,
    dirty, values, login: () => login(), check: () => check(), checking, checkResult,
    metadataLogin: () => login(true), metadataCheck: () => check(true), metadataChecking, metadataCheckResult,
  };
}

export type ConnectionForm = ReturnType<typeof useConnectionForm>;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-x-3">
      <label className="pt-1.5">{label}</label>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className="text-[0.75rem] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function ConnectionSection({ form }: { form: ConnectionForm }) {
  const metadataModelId = useId();
  const metadataProviderId = useId();
  const spec = form.spec;
  const isCli = spec?.kind === "cli";
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="接続先" className="grid grid-cols-2 gap-2">
        {form.providers.map(({ id, label, description, kind }) => {
          const selected = form.provider === id;
          const Icon = kind === "http" ? Globe : SquareTerminal;
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
                <span className="block font-medium">{label}</span>
                <span className="block text-[0.75rem] leading-snug text-muted-foreground">{description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        {spec?.fields.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint || undefined}>
            <Input value={form.option(field.key)} onChange={(e) => form.setOption(field.key)(e.target.value)}
              placeholder={field.placeholder} />
          </Field>
        ))}
        {spec?.needs_api_key && (
          <Field label="API キー" hint="保存されず、アプリの終了時に破棄されます。環境変数 PAPEER_API_KEY でも指定できます。">
            <Input type="password" value={form.apiKey} onChange={(e) => form.setApiKey(e.target.value)} autoComplete="off" />
          </Field>
        )}
        <Field label="モデル">
          <div className="flex gap-2">
            {!isCli ? (
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
          {isCli && !form.modelOptions.some((m) => m.id === form.model) && (
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
        <div className="space-y-2 rounded-lg border p-3">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={form.metadataAi} onChange={e => form.setMetadataAi(e.target.checked)}
              aria-describedby="paper-metadata-ai-hint" />
            論文情報の取得にAIを使う
          </label>
          <p id="paper-metadata-ai-hint" className="text-[0.75rem] leading-relaxed text-muted-foreground">
            初期値はOFFです。ONにすると、PDF追加時に不足している筆頭著者・出版年・掲載誌・DOIなどを調べます。
            論文の冒頭のテキストを情報取得用のAIへ送り、利用枠・トークンを消費します。入力済みの情報は保持します。
            タイトルやDOIなどは、外部の書誌情報サービスにも送信します。
          </p>
          <div className="space-y-1">
            <label htmlFor={metadataProviderId} className="block">情報取得の接続先</label>
            <NativeSelect id={metadataProviderId} aria-label="情報取得の接続先" value={form.metadataProvider}
              onChange={e => form.setMetadataProvider(e.target.value)} disabled={!form.metadataAi}>
              <option value="">翻訳などと同じ接続先</option>
              {form.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </NativeSelect>
          </div>
          {form.metadataProvider && form.metadataProvider !== form.provider && (
            <div className="space-y-3">
              {form.metadataSpec?.fields.map(field => (
                <Field key={field.key} label={field.label} hint={field.hint || undefined}>
                  <Input aria-label={`情報取得の${field.label}`} value={form.metadataOption(field.key)}
                    onChange={e => form.setMetadataOption(field.key)(e.target.value)}
                    placeholder={field.placeholder} disabled={!form.metadataAi} />
                </Field>
              ))}
              {form.metadataSpec?.needs_api_key && !spec?.needs_api_key && (
                <Field label="API キー" hint="Ollamaをローカルで使う場合は空欄で使えます。キーは保存されず、終了時に破棄されます。">
                  <Input aria-label="情報取得のAPI キー" type="password" value={form.apiKey}
                    onChange={e => form.setApiKey(e.target.value)} autoComplete="off" disabled={!form.metadataAi} />
                </Field>
              )}
              <p className="text-[0.75rem] text-muted-foreground">接続先ごとのURL・CLIの設定とAPIキーは、上の接続設定と共通です。</p>
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor={metadataModelId} className="block">情報取得モデル</label>
            <Input id={metadataModelId} aria-label="情報取得モデル" list={`${metadataModelId}-choices`}
              value={form.metadataModel} onChange={e => form.setMetadataModel(e.target.value)}
              disabled={!form.metadataAi} placeholder={form.metadataFallbackModel || "モデル名（空欄なら接続先の既定値）"}
              aria-describedby={`${metadataModelId}-hint`} />
            <datalist id={`${metadataModelId}-choices`}>
              {form.metadataModelOptions.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </datalist>
            <p id={`${metadataModelId}-hint`} className="text-[0.75rem] text-muted-foreground">
              情報取得の接続先のモデルを選ぶか直接入力できます。空欄なら、その接続先の通常モデルを使います。
              Ollamaではインストール済みのモデル名を入力してください。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {form.metadataSpec?.needs_login && form.metadataProvider && form.metadataProvider !== form.provider && (
              <Button variant="outline" onClick={form.metadataLogin} disabled={!form.metadataAi}><LogIn /> ログイン</Button>
            )}
            <Button variant="outline" onClick={form.metadataCheck} disabled={!form.metadataAi || form.metadataChecking}>
              {form.metadataChecking ? <Loader2 className="animate-spin" /> : <PlugZap />}
              情報取得の接続を確認
            </Button>
          </div>
          {form.metadataCheckResult && (
            <p className={cn("text-[0.75rem] whitespace-pre-wrap", form.metadataCheckResult.ok ? "text-success" : "text-destructive")}>
              {form.metadataCheckResult.text}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          {spec?.needs_login && (
            <Button variant="outline" onClick={form.login}>
              <LogIn /> ログイン
            </Button>
          )}
          <Button variant="outline" onClick={form.check} disabled={form.checking}>
            {form.checking ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {form.checking ? "確認中…" : "接続を確認"}
          </Button>
          <span className="text-[0.75rem] text-muted-foreground">入力中の内容で確認します（保存はされません）</span>
        </div>
        {form.checkResult && (
          <p className={cn("flex items-start gap-1.5 text-[0.75rem] whitespace-pre-wrap",
            form.checkResult.ok ? "text-success" : "text-destructive")}>
            {form.checkResult.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <XCircle className="mt-px size-3.5 shrink-0" />}
            {form.checkResult.text}
          </p>
        )}
      </div>

      <p className="text-[0.75rem] leading-relaxed text-muted-foreground">
        {!isCli
          ? "翻訳・解説・チャットを実行すると、対象テキストがこの API へ送られます。接続先によっては従量課金になります。"
          : "翻訳・解説・チャットを実行すると、対象テキストがこの CLI へ送られます。実行できるかどうかは各ツールのログイン状態と利用枠に従います。"}
      </p>
    </div>
  );
}
