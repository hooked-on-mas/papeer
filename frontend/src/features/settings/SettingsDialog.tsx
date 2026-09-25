import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, FileText, Loader2, Palette, RefreshCw, Settings } from "lucide-react";
import { apiRequest } from "../../api/client";
import { PROVIDER_LABELS, type SettingsData } from "../../api/hooks";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useTheme } from "../../app/ThemeProvider";
import { useStore } from "../../store";
import { showMessage } from "../../components/AppDialogs";
import { showError, startJob } from "../jobs/jobEvents";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Option = { id: string; name: string };
const PROVIDERS = ["gemini", "claude", "codex", "api"] as const;
const CLI_LABELS: Record<string, { label: string; placeholder: string }> = {
  codex: { label: "Codexのパス", placeholder: "通常は空欄で自動検出（npm版やcodex.cmd等）" },
  claude: { label: "Claude Codeのパス", placeholder: "通常は空欄で自動検出（claude.cmd等）" },
  gemini: { label: "Gemini (agy) のパス", placeholder: "通常は空欄で自動検出（agy.exe等）" },
};
const PROMPT_LABELS: Record<string, string> = {
  translation: "翻訳",
  translation_fallback: "翻訳（フォールバック）",
  translation_recovery: "翻訳（再試行）",
  summary_notes: "サマリー（ノート作成）",
  summary_article: "サマリー（記事）",
  chat_keywords: "質問（検索キーワード）",
  chat_answer: "質問（回答）",
};

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();

  const [provider, setProvider] = useState("codex");
  const [cliPaths, setCliPaths] = useState<Record<string, string>>({ codex: "", claude: "", gemini: "" });
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiRequest<SettingsData>("GET", "/api/settings"),
    enabled: open,
  });
  const { data: promptsData } = useQuery({
    queryKey: ["prompts"],
    queryFn: () => apiRequest<Record<string, string>>("GET", "/api/prompts"),
    enabled: open,
  });

  useEffect(() => {
    if (!open || !settings) return;
    setProvider(settings.provider || "codex");
    setCliPaths({ codex: settings.codex_path || "", claude: settings.claude_path || "", gemini: settings.gemini_path || "" });
    // Model and effort are remembered per connection while the dialog is open.
    setModels({ [settings.provider]: settings.model || "" });
    setEfforts({ [settings.provider]: settings.reasoning_effort || "" });
    setApiBase(settings.api_base || "");
    setApiKey(settings.api_key || "");
    setCheckResult(null);
  }, [open, settings]);

  useEffect(() => {
    if (open && promptsData) setPrompts(promptsData);
  }, [open, promptsData]);

  const cliPath = cliPaths[provider] ?? "";
  const { data: modelOptions = [], isFetching: loadingModels, refetch: refetchModels } = useQuery({
    queryKey: ["models", provider, cliPath],
    queryFn: () => apiRequest<Option[]>("GET", `/api/providers/${provider}/models?cli_path=${encodeURIComponent(cliPath)}`),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const model = models[provider] ?? modelOptions[0]?.id ?? "";
  const { data: effortOptions = [] } = useQuery({
    queryKey: ["efforts", provider, model],
    queryFn: () => apiRequest<Option[]>("GET",
      `/api/providers/${provider}/efforts?model=${encodeURIComponent(model)}&cli_path=${encodeURIComponent(cliPath)}`),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const chosenEffort = efforts[provider] ?? "";
  // Fall back to the first choice when the model does not offer the saved value.
  const effort = effortOptions.some((o) => o.id === chosenEffort) ? chosenEffort : (effortOptions[0]?.id ?? "");
  const isApi = provider === "api";
  const hasEfforts = effortOptions.length > 1;

  const currentValues = () => ({
    provider,
    model,
    reasoning_effort: hasEfforts ? effort : "",
    api_base: apiBase.trim(),
    api_key: apiKey.trim(),
    codex_path: cliPaths.codex.trim(),
    claude_path: cliPaths.claude.trim(),
    gemini_path: cliPaths.gemini.trim(),
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PUT", "/api/settings", currentValues());
      if (promptsData) {
        const changed = Object.fromEntries(Object.entries(prompts).filter(([k, v]) => promptsData[k] !== v));
        if (Object.keys(changed).length) await apiRequest("PUT", "/api/prompts", changed);
      }
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
      useStore.getState().setStatus("接続設定を保存しました。APIキーはこの起動中のみ保持します。");
      onOpenChange(false);
    } catch (error) {
      showError(error, "設定を保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  const handleLogin = async () => {
    try {
      const result = await apiRequest<{ message: string }>("POST", "/api/providers/login", currentValues());
      await showMessage(result.message.includes("すでに") ? "ログイン状態" : "ログイン", result.message);
    } catch (error) {
      showError(error, "CLIの準備エラー");
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      await startJob("/api/providers/check", currentValues(), { kind: "check", paperId: null }, (event) => {
        setChecking(false);
        if (event.status === "succeeded") setCheckResult({ ok: true, text: String(event.result) });
        else setCheckResult({ ok: false, text: event.error || "接続を確認できませんでした。" });
      });
    } catch (error) {
      setChecking(false);
      setCheckResult({ ok: false, text: (error as Error).message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            設定
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="llm" className="flex flex-col h-[540px]">
          <div className="px-6 border-b shrink-0">
            <TabsList className="bg-transparent space-x-2">
              <TabsTrigger value="llm"><Cpu className="w-4 h-4 mr-2" /> AI接続</TabsTrigger>
              <TabsTrigger value="appearance"><Palette className="w-4 h-4 mr-2" /> 表示</TabsTrigger>
              <TabsTrigger value="prompts"><FileText className="w-4 h-4 mr-2" /> プロンプト</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="llm" className="m-0 space-y-4 text-[13px]">
              <p className="text-muted-foreground">翻訳・解説・質問を実行すると、対象テキストが選択したAI接続へ送られます。</p>
              <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-3">
                <label>接続先</label>
                <NativeSelect value={provider} onChange={(e) => { setProvider(e.target.value); setCheckResult(null); }}>
                  {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>)}
                </NativeSelect>

                <label>モデル</label>
                <div className="flex gap-2">
                  <Input
                    value={model}
                    list="settings-model-options"
                    onChange={(e) => setModels({ ...models, [provider]: e.target.value })}
                    placeholder={loadingModels ? "取得中…" : "モデル名"}
                  />
                  <datalist id="settings-model-options">
                    {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </datalist>
                  <Button variant="outline" onClick={() => refetchModels()} disabled={loadingModels}>
                    <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loadingModels ? "animate-spin" : ""}`} />
                    {loadingModels ? "取得中..." : "再取得"}
                  </Button>
                </div>

                {hasEfforts && (
                  <>
                    <label>推論の強さ（effort）</label>
                    <NativeSelect value={effort} onChange={(e) => setEfforts({ ...efforts, [provider]: e.target.value })}>
                      {effortOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </NativeSelect>
                  </>
                )}

                {!isApi && (
                  <>
                    <label>{CLI_LABELS[provider]?.label}</label>
                    <Input
                      value={cliPath}
                      onChange={(e) => setCliPaths({ ...cliPaths, [provider]: e.target.value })}
                      placeholder={CLI_LABELS[provider]?.placeholder}
                    />
                  </>
                )}

                {isApi && (
                  <>
                    <label>API URL</label>
                    <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://api.openai.com/v1" />
                    <label>APIキー</label>
                    <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                      placeholder="この起動中のみ保持 / PAPERDESK_API_KEYでも設定可" />
                  </>
                )}
              </div>

              {hasEfforts && (
                <p className="text-[12px] text-muted-foreground whitespace-pre-line">
                  {"effortを上げると推論に使う時間・トークンが増える場合があります。対応値はモデルによって異なります。\n"
                    + "翻訳・解説・質問の新しいAI処理に適用します。翻訳済みの部分は引き続き再利用します。"}
                </p>
              )}

              <div className="flex items-center gap-2">
                {!isApi && <Button variant="outline" onClick={handleLogin}>ログイン (CLI)</Button>}
                <Button variant="outline" onClick={handleCheck} disabled={checking}>
                  {checking && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                  {checking ? "確認中..." : "接続を確認"}
                </Button>
              </div>
              {checkResult && (
                <p className={`text-[12px] whitespace-pre-wrap ${checkResult.ok ? "text-success" : "text-destructive"}`}>
                  {checkResult.text}
                </p>
              )}

              <p className="text-[12px] text-muted-foreground whitespace-pre-line leading-relaxed">
                {"CLI接続（Gemini agy / Claude Code / Codex）は各ツールのログイン状態と利用枠に従います。\n"
                  + "ローカル例: http://localhost:11434/v1（Ollama）\n"
                  + "ChatGPT接続はCodexの利用権限と利用枠に従います。\n"
                  + "APIキーでの利用は接続先の従量課金となる場合があります。APIキーは保存されず、アプリ終了時に破棄されます。"}
              </p>
            </TabsContent>

            <TabsContent value="appearance" className="m-0 space-y-4 text-[13px]">
              <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-3">
                <label>テーマ</label>
                <NativeSelect value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                  <option value="system">システムに合わせる</option>
                  <option value="light">ライト</option>
                  <option value="dark">ダーク</option>
                </NativeSelect>
              </div>
            </TabsContent>

            <TabsContent value="prompts" className="m-0 space-y-4">
              <div className="text-[13px] text-muted-foreground">AIへの指示文をカスタマイズできます（空にすると既定の文面に戻ります）。</div>
              {Object.keys(prompts).map((key) => (
                <div key={key} className="grid gap-1.5">
                  <label className="text-[13px] font-medium">{PROMPT_LABELS[key] ?? key}</label>
                  <textarea
                    className="min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-[12px] font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={prompts[key]}
                    onChange={(e) => setPrompts({ ...prompts, [key]: e.target.value })}
                  />
                </div>
              ))}
            </TabsContent>
          </div>

          <div className="px-6 py-3 border-t bg-muted/20 flex justify-end gap-2 shrink-0">
            <Button variant="outline" onClick={() => onOpenChange(false)}>キャンセル</Button>
            <Button onClick={handleSave} disabled={saving || !settings}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
