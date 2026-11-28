import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { showError } from "@/components/errorDialog";
import { showToast } from "@/components/toast";
import { flushPendingSaves } from "@/lib/pendingSaves";
import { shell, joinPath } from "@/shell";
import { isRunning, useStore } from "@/store";
import { CloudDriveSection } from "./CloudDriveSection";
import { VersionNoticeSetting } from "./VersionNoticeHost";

export function DriveSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["storage"], queryFn: async () => unwrap(api.GET("/api/storage")) });
  const [folder, setFolder] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useStore(s => s.activeJobs.some(isRunning)) || pending;
  const chooseFolder = async () => {
    try {
      const parent = await shell.openFolder();
      if (parent) setFolder(joinPath(parent, "Papeer"));
    } catch (e) { showError(e, "フォルダーを選択できませんでした"); }
  };
  const change = async (cancel = false) => {
    setPending(true);
    try {
      const failure = await flushPendingSaves();
      if (failure) throw new Error(failure.message);
      if (cancel) await unwrap(api.DELETE("/api/storage/pending"));
      else await unwrap(api.PUT("/api/storage", { body: { path: folder ?? data?.pending_path ?? "" } }));
      await queryClient.invalidateQueries({ queryKey: ["storage"] });
      showToast({ title: cancel ? "保存先の変更を取り消しました" : "保存先の変更を予約しました",
        description: cancel ? undefined : "アプリを終了して、もう一度起動すると新しい保存先に切り替わります。", tone: "success" });
    } catch (e) { showError(e, "保存先を変更できませんでした"); }
    finally { setPending(false); }
  };
  return <div className="space-y-4 text-sm">
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-medium">このPCの保存先</h3>
      <p>PDF・メモ・書き込み・設定など、ライブラリ全体の保存先を選びます。</p>
      {error && <p role="alert">保存先を読み込めませんでした。</p>}
      {!data && !error && <p>読み込み中…</p>}
      {data && <>
        <p className="break-all">現在の保存先：{data.path}</p>
        {data.missing && <p role="alert" className="text-destructive">データフォルダーが見つかりません。元の場所に戻すか、外付けドライブの接続を確認してください。</p>}
        {data.overridden && <p>環境変数 PAPEER_DATA_DIR / PAPERDESK_DATA_DIR で保存先が指定されています。変更するには環境変数を外して起動してください。</p>}
        <label htmlFor="storage-folder" className="block">新しい保存先</label>
        <div className="flex gap-2">
          <Input id="storage-folder" value={folder ?? data.pending_path ?? ""} disabled={busy || data.overridden || data.missing}
            placeholder="保存先フォルダーの絶対パス" onChange={e => setFolder(e.target.value)} />
          <Button variant="outline" disabled={busy || data.overridden || data.missing} onClick={() => void chooseFolder()}>フォルダーを選択</Button>
        </div>
        <p className="text-xs text-muted-foreground">フォルダー選択では、選んだ場所の中の Papeer を使います。空のフォルダーのパスを直接入力することもできます。</p>
        <p>次回起動時に最新のデータをコピーして切り替えます。元の保存先のデータも残ります。</p>
        <Button disabled={busy || data.overridden || data.missing || !(folder ?? data.pending_path ?? "").trim()} onClick={() => void change()}>保存先を変更</Button>
        {data.pending_path && <div role="status" className="space-y-2">
          <p className="break-all">次回起動時の保存先：{data.pending_path}</p>
          <Button variant="outline" disabled={busy} onClick={() => void change(true)}>変更を取り消す</Button>
        </div>}
        {data.error && <p role="alert" className="text-destructive">{data.error}</p>}
      </>}
    </section>
    <CloudDriveSection />
    <VersionNoticeSetting />
  </div>;
}
