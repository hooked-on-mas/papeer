import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, FolderOpen, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { useCollections, usePaperList, type PaperData } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { UsageLine } from "@/components/UsageLine";
import { jobCount } from "@/features/jobs/jobSelectors";
import { onAppEvent } from "@/lib/appEvents";
import { folderAncestors } from "@/lib/collectionPath";
import { isImeKey } from "@/lib/imeKeys";
import { firstLine } from "@/lib/errorReports";
import { useStore } from "@/store";
import {
  applyOrganize, cancelOrganize, chooseDestination, closeOrganize, discardProposal, includePapers, openOrganize,
  renameProposedFolder, restartOrganize, reviseOrganize, setOrganizeFeedback, setOrganizeInstruction, setOrganizeSource, startOrganize,
} from "./organizeActions";
import {
  commonFolder, createdFolders, destinationChoices, draftEdited, MAX_ORGANIZE_PAPERS, movingMoves, organizableCounts,
  organizeCandidates, organizeRows, withAncestors, type DraftMove, type OrganizeDraft, type OrganizeRow,
} from "./organizePlan";
import { useOrganize } from "./organizeStore";

const NO_PAPERS: PaperData[] = [];
const NO_FOLDERS: string[] = [];
const collator = new Intl.Collator("ja", { sensitivity: "base" });

/** Examples of an instruction, added to the text with a click. */
const INSTRUCTION_EXAMPLES = ["研究分野別に", "手法別に", "既存のフォルダーに合わせて"];

const TEXTAREA = "w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/** `phrase` added to `text` after a comma, unless it is there already. */
function withPhrase(text: string, phrase: string): string {
  const trimmed = text.trim();
  if (!trimmed) return phrase;
  return trimmed.includes(phrase) ? text : `${trimmed.replace(/[、,。]$/, "")}、${phrase}`;
}

/**
 * The dialog that has the AI sort papers into folders, apart from the paper on screen and the side
 * panel: it works on the whole library. Opened by the "open-organize-dialog" event (the library's menus,
 * its header and the notice after adding PDFs); mounted once, in the app shell.
 */
export function OrganizeDialogHost() {
  useEffect(() => onAppEvent("open-organize-dialog", (request) => void openOrganize(request)), []);
  const open = useOrganize((s) => s.open);
  const applying = useOrganize((s) => s.applying);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !applying) closeOrganize(); }}>
      {/* The queries below run only while the dialog is open. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 overflow-hidden sm:max-w-3xl" showCloseButton={!applying}>
        <OrganizeContent />
      </DialogContent>
    </Dialog>
  );
}

function OrganizeContent() {
  const draft = useOrganize((s) => s.draft);
  const busy = useOrganize((s) => s.busy);
  const target = useOrganize((s) => s.target);
  const requested = useOrganize((s) => s.requested);
  const instruction = useOrganize((s) => s.instruction);
  const outcome = useOrganize((s) => s.outcome);
  const jobId = useOrganize((s) => s.jobId);
  const job = useStore((s) => (jobId ? s.activeJobs.find((j) => j.job_id === jobId) : undefined));
  const sortOrder = useStore((s) => s.sortOrder);
  const { data: papers, isError: papersFailed } = usePaperList("", sortOrder);
  const { data: collections = NO_FOLDERS } = useCollections();
  const allPapers = papers ?? NO_PAPERS;

  // Every folder there is, with its parents: the choices of the folder menus and the names a new one may not take.
  const folders = useMemo(() => {
    const names = new Set<string>();
    for (const name of collections) folderAncestors(name).forEach((path) => names.add(path));
    for (const paper of allPapers) folderAncestors(paper.collection_name || "").forEach((path) => names.add(path));
    return [...names].sort(collator.compare);
  }, [collections, allPapers]);
  const existing = useMemo(() => withAncestors(folders), [folders]);

  // The papers an organization of this target covers, and the notebooks of it that it does not.
  const { papers: chosen, excluded } = useMemo(() => organizeCandidates(allPapers, target), [allPapers, target]);
  // New folders are made under the folder that holds the selected papers (their common folder), or, for a
  // selection from different folders, under the part of the path they share, so at the top for papers of
  // unrelated folders.
  const source = target.paperIds ? commonFolder(chosen.map((paper) => paper.collection_name || "")) : target.source;
  const counts = useMemo(() => organizableCounts(allPapers), [allPapers]);

  const status = busy ? (
    <div role="status" className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-[0.8125rem]">
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{job?.message || "準備中..."}{jobCount(job) && `（${jobCount(job)}）`}</span>
      <Button size="sm" variant="outline" disabled={!jobId} onClick={() => void cancelOrganize()}>中止</Button>
    </div>
  ) : outcome && (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
      {outcome.kind === "cancelled" ? "案の作成を中止しました。" : `案を作れませんでした。${outcome.message ? firstLine(outcome.message) : ""}`}
    </p>
  );

  if (!draft) {
    return <SetupStep papers={chosen} excluded={excluded} loaded={papers !== undefined} loadFailed={papersFailed} folders={folders}
      counts={counts} source={source} instruction={instruction} paperTarget={!!target.paperIds} status={status} />;
  }
  return <ProposalStep draft={draft} existing={existing} folders={folders} status={status} paperTarget={!!requested?.paperIds}
    source={requested?.source ?? draft.source} paperCount={requested?.paperIds?.length ?? 0} />;
}

/** The first step: what to organize, and the instruction. */
function SetupStep({ papers, excluded, loaded, loadFailed, folders, counts, source, instruction, paperTarget, status }: {
  papers: PaperData[]; excluded: number; loaded: boolean; loadFailed: boolean; folders: string[]; counts: Map<string, number>;
  source: string; instruction: string; paperTarget: boolean; status: ReactNode;
}) {
  const busy = useOrganize((s) => s.busy);
  const count = papers.length;
  const tooMany = count > MAX_ORGANIZE_PAPERS;
  // A selection with a notebook in it is not organized with the notebook left out: the menu does not offer it, and so neither does this.
  const mixed = paperTarget && excluded > 0;
  const ready = loaded && count > 0 && !tooMany && !mixed && !busy;
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  // Straight to typing the instruction; the folder is already the one asked for.
  useEffect(() => { instructionRef.current?.focus(); }, []);
  // Notebooks are not papers to sort: a folder's are left out and said so, a selection's are refused.
  const leftOut = !paperTarget && excluded > 0 ? `ノート${excluded}件は対象外です。` : "";
  const message = !loaded ? (loadFailed ? "論文の一覧を読み込めませんでした。" : "論文の一覧を読み込んでいます…")
    : mixed ? "選択にノートが含まれています。AIで分けられるのは論文（PDF）だけです。論文だけを選び直してください。"
      : tooMany ? `整理できるのは${MAX_ORGANIZE_PAPERS}件までです（${count}件あります）。フォルダーや選択で絞ってください。`
        : count === 0 ? (paperTarget ? "整理する論文がありません。" : `${source ? "このフォルダーに直接入っている論文がありません。" : "未分類に論文がありません。"}${leftOut}`)
          : paperTarget ? `選択した${count}件の論文を調べます。新しいフォルダーは${source ? `「${source}」の下` : "ライブラリの直下"}に作ります。`
            : `直接入っている${count}件の論文を調べます。子フォルダーの論文は含みません。${leftOut}`;
  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden="true" />AIでフォルダーに分ける</DialogTitle>
        <DialogDescription>
          論文の内容をAIが読み、フォルダーへの振り分け案を作ります。案を確認して、直してから移動します（PDFファイルは動きません）。
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-0.5 py-0.5">
        <div className="grid gap-1.5">
          <label htmlFor="organize-source" className="text-sm font-medium">
            {paperTarget ? "整理する論文" : "整理するフォルダー"}
          </label>
          {paperTarget ? (
            <p id="organize-source" className="rounded-lg border bg-muted/40 px-2.5 py-1.5 text-sm">選択した論文 {count}件</p>
          ) : (
            <NativeSelect id="organize-source" value={source} disabled={busy} onChange={(e) => setOrganizeSource(e.target.value)}>
              {["", ...folders].map((path) => (
                <option key={path} value={path}>{path || "未分類"}（{counts.get(path) ?? 0}件）</option>
              ))}
            </NativeSelect>
          )}
          <p className={`text-[0.75rem] ${tooMany || mixed || (loaded && count === 0) || loadFailed ? "text-destructive" : "text-muted-foreground"}`}>{message}</p>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="organize-instruction" className="text-sm font-medium">指示（任意）</label>
          <textarea id="organize-instruction" ref={instructionRef} rows={3} className={TEXTAREA} value={instruction} disabled={busy}
            placeholder="例：研究分野別に分けてください。既存のフォルダーに合うものはそちらへ。"
            onChange={(e) => setOrganizeInstruction(e.target.value)} />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="指示の例">
            {INSTRUCTION_EXAMPLES.map((example) => (
              <Button key={example} type="button" size="xs" variant="outline" disabled={busy}
                onClick={() => setOrganizeInstruction(withPhrase(instruction, example))}>{example}</Button>
            ))}
          </div>
        </div>
        {status}
      </div>
      <DialogFooter className="shrink-0">
        <Button variant="outline" onClick={closeOrganize}>閉じる</Button>
        <Button disabled={!ready} onClick={() => void startOrganize(source)}>
          <Sparkles aria-hidden="true" />案を作る
        </Button>
      </DialogFooter>
    </>
  );
}

/** The second step: the proposal as folders with the papers that go there, to check, change and apply. */
function ProposalStep({ draft, existing, folders, status, paperTarget, source, paperCount }: {
  draft: OrganizeDraft; existing: ReadonlySet<string>; folders: string[]; status: ReactNode; paperTarget: boolean;
  source: string; paperCount: number;
}) {
  const busy = useOrganize((s) => s.busy);
  const applying = useOrganize((s) => s.applying);
  const conflict = useOrganize((s) => s.conflict);
  const usage = useOrganize((s) => s.usage);
  const feedback = useOrganize((s) => s.feedback);
  const rows = useMemo(() => organizeRows(draft, existing), [draft, existing]);
  const choices = useMemo(() => destinationChoices(draft, folders), [draft, folders]);
  const moving = movingMoves(draft).length;
  const destinations = new Set(movingMoves(draft).map((move) => move.to).filter(Boolean)).size;
  const created = createdFolders(draft, existing).length;
  const locked = busy || applying;
  const canApply = moving > 0 && !locked && !conflict;
  const canRevise = !locked && (feedback.trim() !== "" || draftEdited(draft));
  const target = paperTarget ? `選択した論文 ${paperCount}件` : `「${source || "未分類"}」`;
  return (
    <>
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden="true" />AIでフォルダーに分ける</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-2">
          <span>分け方の案です。対象：{target}{draft.instruction ? `　指示：${draft.instruction}` : ""}</span>
          <Button type="button" variant="link" size="xs" className="h-auto p-0" disabled={locked} onClick={() => void discardProposal()}>
            対象・指示を変える
          </Button>
        </DialogDescription>
      </DialogHeader>
      {draft.message && <p className="shrink-0 rounded-md bg-muted/50 px-3 py-2 text-[0.8125rem] whitespace-pre-line">{draft.message}</p>}
      <p className="shrink-0 text-[0.8125rem]" aria-live="polite">
        {moving
          ? `${moving}件を${destinations}個のフォルダーへ移動します${created ? `（新しいフォルダー${created}個を作成）` : ""}。`
          : "移動する論文はありません。"}
      </p>
      {rows.length > 0 && (
        <ul aria-label="移動案" className="min-h-0 flex-1 overflow-y-auto rounded-md border p-2">
          {rows.map((row) => row.kind === "folder"
            ? <FolderRowView key={row.key} row={row} existing={existing} disabled={locked} />
            : <PaperRowView key={row.key} move={row.move} depth={row.depth} choices={choices} disabled={locked} />)}
        </ul>
      )}
      {conflict && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
          <span className="min-w-0 flex-1">分類が変わったため、もう一度案を作ってください。</span>
          <Button size="sm" variant="outline" disabled={locked} onClick={() => void restartOrganize()}>案を作り直す</Button>
        </div>
      )}
      {status}
      <div className="grid shrink-0 gap-1.5">
        <label htmlFor="organize-feedback" className="text-sm font-medium">追加の指示（任意）</label>
        <div className="flex items-start gap-2">
          <textarea id="organize-feedback" rows={2} className={`${TEXTAREA} flex-1`} value={feedback} disabled={locked}
            placeholder="例：もっと粗く分けてください。強化学習は1つにまとめてください。"
            onChange={(e) => setOrganizeFeedback(e.target.value)} />
          <Button variant="outline" disabled={!canRevise} onClick={() => void reviseOrganize()}>作り直す</Button>
        </div>
        <p className="text-[0.75rem] text-muted-foreground">チェックを外した論文と移動先の変更は、作り直しの案に引き継ぎます。</p>
      </div>
      <UsageLine usage={usage} className="shrink-0" />
      <DialogFooter className="shrink-0">
        <Button variant="outline" disabled={applying} onClick={closeOrganize}>閉じる</Button>
        <Button disabled={!canApply} onClick={() => void applyOrganize()}>
          {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          {moving}件を移動
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * A destination folder of the proposal: checks or unchecks all its papers, and renames it when it is
 * new. The reason the AI gave for a new folder is under its name.
 */
function FolderRowView({ row, existing, disabled }: {
  row: Extract<OrganizeRow, { kind: "folder" }>; existing: ReadonlySet<string>; disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.name);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLInputElement>(null);
  const some = row.included > 0;
  const all = row.paperIds.length > 0 && row.included === row.paperIds.length;
  useEffect(() => {
    if (boxRef.current) boxRef.current.indeterminate = some && !all;
  }, [some, all]);

  const commit = () => {
    const reason = renameProposedFolder(row.path, text, existing);
    if (reason) setError(reason);
    else setEditing(false);
  };
  const cancel = () => {
    setEditing(false);
    setError("");
    setText(row.name);
  };
  const label = row.path || "未分類";
  return (
    <li className="mt-2 rounded-md bg-muted/40 px-1.5 py-1 first:mt-0" style={{ marginLeft: `${row.depth * 16}px` }}>
      <div className="flex items-center gap-2">
        {row.paperIds.length > 0 ? (
          <input ref={boxRef} type="checkbox" checked={all} disabled={disabled} aria-label={`「${label}」へ移動する論文をすべて選ぶ`}
            onChange={(e) => includePapers(row.paperIds, e.target.checked)} />
        ) : <span className="w-[13px]" aria-hidden="true" />}
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {editing ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); commit(); }}>
            <Input autoFocus aria-label={`「${row.path}」の新しい名前`} className="h-7 flex-1" value={text} aria-invalid={!!error}
              onChange={(e) => { setText(e.target.value); setError(""); }}
              onKeyDown={(e) => {
                if (isImeKey(e.nativeEvent)) return;
                // Esc leaves the name, not the dialog.
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
              }} />
            <Button type="submit" size="icon-sm" variant="outline" aria-label="名前を確定"><Check aria-hidden="true" /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="名前の変更をやめる" onClick={cancel}><X aria-hidden="true" /></Button>
          </form>
        ) : (
          <span className="min-w-0 truncate font-medium" title={label}>{row.name}</span>
        )}
        {row.isNew && !editing && <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[0.75rem] font-medium leading-4 text-primary">新規</span>}
        {!editing && <span className="ml-auto shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">{row.moving}件</span>}
        {row.isNew && !editing && (
          <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={`「${row.path}」の名前を変更`}
            title="フォルダー名を変更" onClick={() => { setText(row.name); setEditing(true); }}>
            <Pencil aria-hidden="true" />
          </Button>
        )}
      </div>
      {error && <p role="alert" className="pl-6 text-[0.75rem] text-destructive">{error}</p>}
      {row.reason && <p className="pl-6 text-[0.75rem] text-muted-foreground">{row.reason}</p>}
    </li>
  );
}

/**
 * One paper of the proposal: its check, where it was and goes, and the menu to send it elsewhere.
 * Memoized, so that a change renders the rows it changes only (up to 300 papers).
 */
const PaperRowView = memo(function PaperRowView({ move, depth, choices, disabled }: {
  move: DraftMove; depth: number; choices: string[]; disabled: boolean;
}) {
  const same = move.to === move.from;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 pr-1" style={{ paddingLeft: `${depth * 16 + 6}px` }}>
      <input type="checkbox" checked={move.included && !same} disabled={disabled || same} aria-label={`「${move.title}」を移動する`}
        onChange={(e) => includePapers([move.paperId], e.target.checked)} />
      <div className="min-w-0 flex-1 basis-52">
        <div className={`truncate text-[0.8125rem] ${move.included && !same ? "" : "text-muted-foreground"}`} title={move.title}>{move.title}</div>
        <div className="truncate text-[0.75rem] text-muted-foreground">
          {same ? `移動しません（${move.from || "未分類"}）` : `${move.from || "未分類"} → ${move.to || "未分類"}`}
        </div>
      </div>
      <NativeSelect aria-label={`「${move.title}」の移動先`} className="h-7 w-44 text-[0.8125rem]" value={move.to} disabled={disabled}
        onChange={(e) => chooseDestination(move.paperId, e.target.value)}>
        {choices.map((path) => <option key={path} value={path}>{path || "未分類"}</option>)}
      </NativeSelect>
    </li>
  );
});
