import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { showError } from "@/components/errorDialog";
import { downloadLanguageData } from "@/features/ocr/ocrActions";
import { requestCancel } from "@/features/jobs/jobEvents";
import { isRunning, useStore } from "@/store";
import { QK } from "@/lib/queryKeys";
import {
  engineChoices, formatMegabytes, LANG_CHOICES, LANG_LABELS, MODE_CHOICES,
  type LanguageData, type OcrSettings, type OcrStatus,
} from "@/lib/ocrText";

/**
 * 設定 → OCR: this PC's OCR settings (not synced: papeer/core/ocr.py), saved as soon as they change, the
 * language data with its download, and what the system's OCR and the AI connection can read.
 */
export function OcrSection() {
  const status = useQuery({ queryKey: [QK.ocr], queryFn: async () => await unwrap(api.GET("/api/ocr")) });
  if (status.error) return <p role="alert" className="text-destructive">OCR の状態を読み込めませんでした。</p>;
  if (!status.data) return <p className="text-muted-foreground">読み込み中…</p>;
  return <OcrSettingsView status={status.data} />;
}

export function OcrSettingsView({ status }: { status: OcrStatus }) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const engineId = useId(), langId = useId(), modeHint = useId();
  const save = async (change: Partial<OcrSettings>) => {
    const next = { ...status.settings, ...change };
    setSaving(true);
    try {
      const saved = await unwrap(api.PUT("/api/ocr/settings", { body: next }));
      queryClient.setQueryData<OcrStatus>([QK.ocr], current => current && { ...current, settings: saved });
      void queryClient.invalidateQueries({ queryKey: [QK.ocr] });
    } catch (error) { showError(error, "OCR の設定を保存できませんでした"); }
    finally { setSaving(false); }
  };
  const mode = MODE_CHOICES.find(choice => choice.value === status.settings.mode);
  return <div className="space-y-6">
    <p>スキャンした PDF や文字化けした PDF の「要OCR」のページを、画像から文字を読み取って翻訳できるようにします。この設定はこのPCだけのもので、同期・バックアップはしません（変えるとすぐ保存します）。</p>
    <fieldset className="space-y-2" aria-describedby={modeHint}>
      <legend className="font-medium">論文を追加したとき</legend>
      {MODE_CHOICES.map(choice => <label key={choice.value} className="flex items-center gap-2">
        <input type="radio" name="ocr-mode" value={choice.value} checked={status.settings.mode === choice.value} disabled={saving}
          onChange={() => void save({ mode: choice.value })} />
        {choice.label}
      </label>)}
      <p id={modeHint} className="text-muted-foreground text-xs">{mode?.hint}</p>
    </fieldset>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1">
        <label htmlFor={engineId} className="font-medium">エンジン</label>
        <NativeSelect id={engineId} value={status.settings.engine} disabled={saving}
          onChange={e => void save({ engine: e.target.value as OcrSettings["engine"] })}>
          {engineChoices(status).map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </NativeSelect>
        <p className="text-muted-foreground text-xs">選んだエンジンで読めないときは、ほかのエンジンで読みます。</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={langId} className="font-medium">言語</label>
        <NativeSelect id={langId} value={status.settings.lang} disabled={saving}
          onChange={e => void save({ lang: e.target.value as OcrSettings["lang"] })}>
          {LANG_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </NativeSelect>
      </div>
    </div>
    <LanguageDataList status={status} />
    <section aria-label="使えるエンジン" className="space-y-1">
      <h3 className="font-medium">使えるエンジン</h3>
      <ul className="list-disc space-y-1 pl-5">
        {(["en", "ja"] as const).map(lang => <li key={lang}>
          {LANG_LABELS[lang]}：{status.readable[lang]?.length
            ? status.readable[lang].map(name => ENGINE_NAMES[name] ?? name).join(" → ")
            : <span className="text-amber-700 dark:text-amber-400">読めるエンジンがありません（言語データをダウンロードしてください）</span>}
        </li>)}
        {status.system && <li>{status.system.label}：{status.system.languages.length
          ? `${status.system.languages.map(lang => LANG_LABELS[lang]).join("・")}を読めます`
          : "このPCには認識器がありません（Windows では「設定 → 時刻と言語 → 言語」で言語を追加すると使えます）"}</li>}
        <li>AI で読み直す（翻訳の確認・修正から 1 ページずつ）：{status.ai.available
          ? `${status.ai.label} で使えます。ページの画像を接続先に送り、利用枠を使います。`
          : <span className="text-amber-700 dark:text-amber-400">{status.ai.reason}</span>}</li>
      </ul>
    </section>
  </div>;
}

const ENGINE_NAMES: Record<string, string> = { tesseract: "Tesseract", windows: "Windows の OCR", vision: "macOS の Vision" };

/** Tesseract's language data: what is on this PC, and downloading what is not, with its progress and a way to stop it. */
function LanguageDataList({ status }: { status: OcrStatus }) {
  const job = useStore(s => s.activeJobs.find(j => j.kind === "ocr-data" && isRunning(j)));
  const [failed, setFailed] = useState<string | null>(null);
  const missing = status.language_data.filter(entry => !entry.installed);
  const download = async (entries: LanguageData[]) => {
    setFailed(null);
    const outcome = await downloadLanguageData(entries, status.directory);
    if (!outcome.ok && outcome.error) setFailed(outcome.error);
  };
  return <section aria-label="Tesseract の言語データ" className="space-y-2 rounded border p-3">
    <h3 className="font-medium">Tesseract の言語データ</h3>
    <p className="text-muted-foreground text-xs">保存先：<span className="break-all">{status.directory}</span></p>
    <ul className="space-y-1">
      {status.language_data.map(entry => <li key={entry.lang} className="flex items-center justify-between gap-3">
        <span>{entry.label}（{entry.file}、{formatMegabytes(entry.size)}）</span>
        {entry.installed ? <span className="text-muted-foreground">入っています</span>
          : <Button variant="outline" size="sm" disabled={!!job} aria-label={`${entry.label}の言語データをダウンロード`}
            onClick={() => void download([entry])}>ダウンロード…</Button>}
      </li>)}
    </ul>
    {missing.length > 1 && !job && <Button variant="outline" size="sm" onClick={() => void download(missing)}>まとめてダウンロード…</Button>}
    {job && <div role="status" className="flex items-center gap-3">
      <span className="min-w-0 flex-1 text-xs">{job.message}</span>
      <Button variant="outline" size="sm" onClick={() => void requestCancel(job.job_id).catch(() => undefined)}>中止</Button>
    </div>}
    {failed && <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">ダウンロードできませんでした：{failed}</p>}
  </section>;
}
