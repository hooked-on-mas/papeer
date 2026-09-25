import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { apiRequest } from "../../api/client";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/native-select";

const PROMPT_LABELS: Record<string, string> = {
  translation: "翻訳",
  translation_fallback: "翻訳（フォールバック）",
  translation_recovery: "翻訳（再試行）",
  summary_notes: "サマリー（ノート作成）",
  summary_article: "サマリー（記事）",
  chat_keywords: "質問（検索キーワード）",
  chat_answer: "質問（回答）",
};

/** Edited prompt texts; the dialog owns it so that one 保存 covers every section. */
export function usePromptsForm(open: boolean) {
  const { data: saved } = useQuery({
    queryKey: ["prompts"],
    queryFn: () => apiRequest<Record<string, string>>("GET", "/api/prompts"),
    enabled: open,
  });
  const { data: defaults } = useQuery({
    queryKey: ["prompt-defaults"],
    queryFn: () => apiRequest<Record<string, string>>("GET", "/api/prompts/defaults"),
    enabled: open,
    staleTime: Infinity,
  });
  const [prompts, setPrompts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open && saved) setPrompts(saved);
  }, [open, saved]);

  const names = Object.keys(PROMPT_LABELS).filter((name) => name in prompts)
    .concat(Object.keys(prompts).filter((name) => !(name in PROMPT_LABELS)));
  const changed = saved
    ? Object.fromEntries(Object.entries(prompts).filter(([name, text]) => saved[name] !== text))
    : {};

  /** Texts to PUT: a prompt equal to (or emptied back to) the built-in one drops its custom file. */
  const pendingChanges = () => Object.fromEntries(Object.entries(changed).map(([name, text]) =>
    [name, text.trim() === (defaults?.[name] ?? "").trim() ? "" : text]));

  return {
    names,
    prompts,
    defaults: defaults ?? {},
    setPrompt: (name: string, text: string) => setPrompts((prev) => ({ ...prev, [name]: text })),
    dirty: Object.keys(changed).length > 0,
    pendingChanges,
  };
}

export type PromptsForm = ReturnType<typeof usePromptsForm>;

export function PromptsSection({ form }: { form: PromptsForm }) {
  const [selected, setSelected] = useState("translation");
  const name = form.names.includes(selected) ? selected : (form.names[0] ?? "");
  const text = form.prompts[name] ?? "";
  const defaultText = form.defaults[name];
  const customized = (name: string) =>
    form.defaults[name] !== undefined && (form.prompts[name] ?? "").trim() !== form.defaults[name].trim();

  if (!name) return <p className="text-muted-foreground">読み込み中…</p>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <NativeSelect value={name} onChange={(e) => setSelected(e.target.value)} className="flex-1" aria-label="編集するプロンプト">
          {form.names.map((n) => (
            <option key={n} value={n}>{(PROMPT_LABELS[n] ?? n) + (customized(n) ? "（変更あり）" : "")}</option>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          onClick={() => form.setPrompt(name, defaultText ?? "")}
          disabled={defaultText === undefined || !customized(name)}
          title="この指示文を既定の文面に戻します"
        >
          <RotateCcw /> 既定に戻す
        </Button>
      </div>
      <textarea
        className="min-h-[240px] w-full flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        value={text}
        spellCheck={false}
        onChange={(e) => form.setPrompt(name, e.target.value)}
        placeholder="空のまま保存すると既定の文面を使います。"
        aria-label={PROMPT_LABELS[name] ?? name}
      />
      <p className="text-[12px] text-muted-foreground">
        AI への指示文です。変更は新しく実行する翻訳・サマリー・質問から使われます。
      </p>
    </div>
  );
}
