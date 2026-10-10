"""The commands: each builds its requests, runs the job if there is one, and prints the result.

Every command is HTTP to the sidecar (papeer/cli/__init__.py). A command returns the exit code (0 for
success); a failure it wants to report is a CliError, which main() prints as one line.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path
from typing import Any, Callable
import urllib.parse

from papeer.cli.client import ApiError, CliError, Session, Target
from papeer.cli.connect import EXIT_NO_SIDECAR, Connector
from papeer.cli.jobs import JobInfo, require_success, run_job
from papeer.cli.output import Output, page_ranges, table, truncate
from papeer.core.collection_paths import in_collection, normalize_collection_name
from papeer.core.fileio import atomic_write_json

EXIT_USAGE = 2
MIN_ID_PREFIX = 6
UNFILED = "未分類"
LAUNCHER_LABELS = {"app": "Papeer のウィンドウ", "dev": "開発用の sidecar", "cli": "ヘッドレス（CLI が起動）"}
JOB_STATUS_LABELS = {"running": "実行中", "succeeded": "成功", "failed": "失敗", "cancelled": "中止"}


class Context:
    """What a command works with: the output, the arguments, and (once asked for) the connection."""

    def __init__(self, out: Output, args: argparse.Namespace, connector: Connector | None = None,
                 session: Session | None = None) -> None:
        self.out = out
        self.args = args
        self.connector = connector
        self._session = session

    def session(self, spawn: bool = True) -> Session:
        """The connection (made on first use). `spawn` False: never start a headless sidecar for it."""
        if self._session is None:
            if self.connector is None:
                raise CliError("接続先がありません。", EXIT_NO_SIDECAR)
            self._session = self.connector.connect(spawn=spawn)
        return self._session


# --- Shared helpers ---

def folder_label(name: str) -> str:
    return normalize_collection_name(name) or UNFILED


def all_papers(session: Session, query: str = "") -> list[dict[str, Any]]:
    data = session.get("/api/papers", query={"query": query} if query else None)
    return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []


def resolve_paper(rows: list[dict[str, Any]], spec: str) -> dict[str, Any]:
    """The paper `spec` names: its ID, or the start of it (at least MIN_ID_PREFIX characters, one paper)."""
    wanted = spec.strip().lower()
    for row in rows:
        if str(row.get("id", "")).lower() == wanted:
            return row
    if len(wanted) < MIN_ID_PREFIX:
        raise CliError(f"論文 ID「{spec}」は {MIN_ID_PREFIX} 文字以上で指定してください。", EXIT_USAGE)
    matches = [row for row in rows if str(row.get("id", "")).lower().startswith(wanted)]
    if not matches:
        raise CliError(f"論文が見つかりません: {spec}")
    if len(matches) > 1:
        lines = [f"  {str(row['id'])[:12]}  {row.get('title', '')}" for row in matches[:20]]
        more = [f"  …ほか {len(matches) - 20} 件"] if len(matches) > 20 else []
        raise CliError(f"論文 ID「{spec}」に当てはまる論文が複数あります。もっと長く指定してください:\n"
                       + "\n".join(lines + more))
    return matches[0]


def translation_label(row: dict[str, Any]) -> str:
    if row.get("translation_in_progress"):
        return "翻訳中"
    required = int(row.get("translation_required_count") or 0)
    completed = int(row.get("translation_completed_required_count") or 0)
    if required and completed >= required:
        return "翻訳済み"
    if completed or row.get("translated_count"):
        return f"一部 {completed}/{required}" if required else "一部"
    return "未翻訳"


def titles_of(session: Session) -> dict[str, str]:
    try:
        return {str(row["id"]): str(row.get("title", "")) for row in all_papers(session)}
    except CliError:
        return {}


def usage_line(usage: Any) -> str | None:
    if not isinstance(usage, dict):
        return None
    parts = [f"入力 {usage.get('input_tokens', 0)} トークン", f"出力 {usage.get('output_tokens', 0)} トークン"]
    if isinstance(usage.get("cost_usd"), (int, float)):
        parts.append(f"約 ${usage['cost_usd']:.4f}")
    return "使用量: " + "、".join(parts)


def finish_job(ctx: Context, submit: Callable[[Session], str], *, resume: bool = True) -> JobInfo:
    """run_job with the command line's options, and the job's failure as a CliError."""
    return require_success(run_job(ctx.session(), submit, out=ctx.out, reconnects=2 if resume else 0))


# --- status ---

def cmd_status(ctx: Context) -> int:
    out = ctx.out
    try:
        session = ctx.session(spawn=False)
    except CliError as error:
        if error.exit_code != EXIT_NO_SIDECAR:
            raise
        out.emit({"running": False}, "Papeer は起動していません。")
        return EXIT_NO_SIDECAR
    info = session.get("/api/instance")
    jobs = session.get("/api/jobs")
    data = {"running": True, "instance": info, "jobs": jobs}
    lines = []
    launcher = str(info.get("launcher", "")) if isinstance(info, dict) else ""
    label = LAUNCHER_LABELS.get(launcher, launcher or "不明")
    lines.append(f"接続先: {label}  ポート {info.get('port')}  pid {info.get('pid')}  版 {info.get('version')}")
    if info.get("idle_exit"):
        lines.append(f"        何も依頼がなければ {info['idle_exit']:g} 秒で終了します。")
    lines.append(f"ライブラリ: {info.get('data_dir')}")
    if jobs:
        lines.append(f"実行中のジョブ: {len(jobs)} 件")
        lines.append(jobs_table(jobs, indent="  "))
    else:
        lines.append("実行中のジョブ: なし")
    out.emit(data, "\n".join(lines))
    return 0


def jobs_table(jobs: list[dict[str, Any]], indent: str = "") -> str:
    rows = []
    for job in jobs:
        progress = f"{job['done']}/{job['total']}" if job.get("done") is not None and job.get("total") else ""
        rows.append([str(job.get("job_id", ""))[:8], str(job.get("kind", "")), str(job.get("paper_id") or "")[:8],
                     progress, str(job.get("message", ""))])
    text = table(rows, ["ジョブ", "種類", "論文", "進捗", "内容"])
    return "\n".join(indent + line for line in text.splitlines())


# --- add ---

def expand_pdfs(patterns: list[str], recursive: bool) -> tuple[list[str], list[str]]:
    """(absolute paths of the PDFs the arguments stand for, what was wrong with the arguments).

    The shell does not expand globs on Windows, so it is done here. A folder needs -r (its PDFs, at any
    depth); a file that is not a PDF is refused when named, and skipped when a pattern matched it.
    """
    found: list[str] = []
    problems: list[str] = []
    for pattern in patterns:
        pattern = os.path.expanduser(pattern)
        # A file that exists is the file, whatever its name holds ("Smith [2020].pdf"): only what is not
        # there is a pattern.
        magic = glob.has_magic(pattern) and not os.path.exists(pattern)
        candidates = sorted(glob.glob(pattern, recursive=True)) if magic else [pattern]
        if magic and not candidates:
            problems.append(f"一致するファイルがありません: {pattern}")
            continue
        for candidate in candidates:
            path = Path(candidate)
            if path.is_dir():
                if not recursive:
                    if not magic:  # Named: say why it is not taken. Matched by a pattern (*): just not a PDF.
                        problems.append(f"フォルダーです（中の PDF を追加するには -r を付けてください）: {candidate}")
                    continue
                inside = sorted(p for p in path.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf")
                if not inside:
                    problems.append(f"PDF が見つかりません: {candidate}")
                found.extend(str(p) for p in inside)
            elif path.is_file():
                if path.suffix.lower() == ".pdf":
                    found.append(str(path))
                elif not magic:
                    problems.append(f"PDF ではありません: {candidate}")
            else:
                problems.append(f"ファイルが見つかりません: {candidate}")
    unique: dict[str, str] = {}
    for item in found:
        absolute = os.path.abspath(item)
        unique.setdefault(os.path.normcase(absolute), absolute)
    return list(unique.values()), problems


def ensure_folder(session: Session, name: str) -> None:
    """Make the folder `name` when the library has none of that name (an import would create it with its
    first new paper only: a folder that gets only duplicates would not exist)."""
    name = normalize_collection_name(name)
    if not name:
        return
    existing = session.get("/api/collections")
    if isinstance(existing, list) and name in existing:
        return
    try:
        session.post("/api/collections", {"name": name})
    except ApiError as error:
        if error.status != 400 or "既に" not in error.detail:  # Made meanwhile (another window): fine.
            raise


def cmd_add(ctx: Context) -> int:
    out, args = ctx.out, ctx.args
    paths, problems = expand_pdfs(args.paths, args.recursive)
    if problems or not paths:
        for problem in problems:
            out.error(problem)
        if not problems:
            out.error("追加する PDF がありません。")
        return EXIT_USAGE
    folder = normalize_collection_name(args.folder) if args.folder is not None else ""
    if args.folder is not None and not folder:
        out.error("フォルダー名を指定してください。")
        return EXIT_USAGE
    session = ctx.session()
    if folder:
        ensure_folder(session, folder)
    body: dict[str, Any] = {"paths": paths}
    if folder:
        body["collection"] = folder

    def submit(current: Session) -> str:
        return str(current.post("/api/papers/import", body)["job_id"])

    if args.no_wait:
        job_id = submit(session)
        out.emit({"job_id": job_id, "paths": paths}, f"取り込みを開始しました（ジョブ {job_id}）。")
        return 0
    job = finish_job(ctx, submit, resume=not args.no_resume)
    result = job.result if isinstance(job.result, dict) else {}
    ids = [str(item) for item in result.get("paper_ids", [])]
    added = set(result.get("added_ids", []))
    titles = titles_of(session)
    items = []
    for path, paper_id in zip(paths, ids):
        items.append({"path": path, "paper_id": paper_id, "status": "added" if paper_id in added else "duplicate",
                      "title": titles.get(paper_id, "")})
    data = {"added": int(result.get("added", len(added))), "total": len(paths), "papers": items,
            "folder": folder, "restarts": job.restarts, "needs_ocr": result.get("needs_ocr", []),
            "metadata_failures": result.get("metadata_failures", [])}
    rows = [["追加" if item["status"] == "added" else "重複", item["paper_id"][:8], item["title"] or Path(item["path"]).name]
            for item in items]
    lines = [table(rows)] if rows else []
    duplicates = len(paths) - data["added"]
    summary = f"{data['added']} 件を追加しました" if data["added"] else "新しく追加した論文はありません"
    summary += f"（{duplicates} 件はライブラリにありました）。" if duplicates else "。"
    lines.append(summary + (f"フォルダー: {folder}" if folder and data["added"] else ""))
    if job.restarts:
        lines.append("途中で接続し直したため、やり直す前に追加された論文は「重複」と表示されます。")
    if data["needs_ocr"]:
        lines.append(f"OCR が必要なページがある論文: {', '.join(str(i)[:8] for i in data['needs_ocr'])}（Papeer の画面で読み取れます）")
    for failure in data["metadata_failures"]:
        lines.append(f"論文情報の補完に失敗しました: {failure}")
    out.emit(data, "\n".join(lines))
    return 0


# --- ls ---

def cmd_ls(ctx: Context) -> int:
    out, args = ctx.out, ctx.args
    rows = all_papers(ctx.session(), args.query or "")
    if args.folder is not None:
        base = normalize_collection_name(args.folder)

        def inside(row: dict[str, Any]) -> bool:
            name = normalize_collection_name(str(row.get("collection_name", "")))
            if args.all:  # The folder's subfolders too (with no FOLDER given or "": every paper).
                return not base or in_collection(name, base)
            return name == base

        rows = [row for row in rows if inside(row)]
    width = 60 if out.stdout_is_tty else 10_000
    lines = table([[str(row["id"])[:8], truncate(str(row.get("title", "")), width), folder_label(str(row.get("collection_name", ""))),
                    translation_label(row)] for row in rows], ["ID", "タイトル", "フォルダー", "翻訳"]) if rows else ""
    out.emit(rows, lines)
    out.info(f"{len(rows)} 件")
    return 0


# --- folder ---

def folder_counts(session: Session) -> tuple[list[str], dict[str, int]]:
    names = [str(n) for n in session.get("/api/collections")]
    counts: dict[str, int] = {}
    for row in all_papers(session):
        key = normalize_collection_name(str(row.get("collection_name", "")))
        counts[key] = counts.get(key, 0) + 1
    return names, counts


def cmd_folder_list(ctx: Context) -> int:
    names, counts = folder_counts(ctx.session())
    data = {"folders": [{"name": name, "papers": counts.get(name, 0)} for name in names], "unfiled": counts.get("", 0)}
    rows = [[name, f"{counts.get(name, 0)} 件"] for name in names]
    rows.append([UNFILED, f"{counts.get('', 0)} 件"])
    ctx.out.emit(data, table(rows))
    return 0


def folder_argument(value: str) -> str:
    name = normalize_collection_name(value)
    if not name:
        raise CliError("フォルダー名を指定してください。", EXIT_USAGE)
    return name


def cmd_folder_create(ctx: Context) -> int:
    name = folder_argument(ctx.args.name)
    result = ctx.session().post("/api/collections", {"name": name})
    ctx.out.emit(result, f"フォルダー「{result.get('name', name)}」を作りました。")
    return 0


def cmd_folder_rename(ctx: Context) -> int:
    old, new = folder_argument(ctx.args.old), folder_argument(ctx.args.new)
    result = ctx.session().patch("/api/collections/rename", {"old_name": old, "new_name": new})
    ctx.out.emit(result, f"フォルダー「{old}」を「{result.get('name', new)}」に変えました。")
    return 0


def cmd_folder_delete(ctx: Context) -> int:
    out = ctx.out
    name = folder_argument(ctx.args.name)
    if not ctx.args.yes:
        if not out.can_prompt:
            out.error(f"フォルダー「{name}」を削除するには --yes を付けてください。")
            return 1
        if not out.confirm(f"フォルダー「{name}」を削除しますか?（中の論文は削除されず、未分類に移ります） [y/N] "):
            out.info("削除しませんでした。")
            return 1
    result = ctx.session().delete("/api/collections/" + urllib.parse.quote(name, safe="/"))
    token = result.get("undo_token", "")
    restore = f"papeer-cli folder restore {token}"
    data = {**result, "restore_command": restore}
    moved = result.get("moved") or []
    out.emit(data, f"フォルダー「{name}」を削除しました（{len(moved)} 件の論文を未分類に移しました）。\n"
                   f"元に戻すには: {restore}")
    return 0


def cmd_folder_restore(ctx: Context) -> int:
    token = urllib.parse.quote(ctx.args.token.strip(), safe="")
    if not token:
        raise CliError("復元用のトークンを指定してください。", EXIT_USAGE)
    result = ctx.session().post("/api/collections/restore/" + token)
    ctx.out.emit(result, f"フォルダー「{result.get('name', '')}」を元に戻しました。")
    return 0


# --- mv ---

COLLECTION_CHANGED = "collection_changed"
CHANGED_MESSAGE = "分類が変わりました。もう一度実行してください。"


def apply_moves(session: Session, moves: list[dict[str, str]], expected: dict[str, str]) -> dict[str, Any]:
    try:
        return session.post("/api/collections/apply-moves", {"moves": moves, "expected": expected})
    except ApiError as error:
        if error.code == COLLECTION_CHANGED:
            raise CliError(CHANGED_MESSAGE, 1, COLLECTION_CHANGED) from None
        raise


def cmd_mv(ctx: Context) -> int:
    out, args = ctx.out, ctx.args
    session = ctx.session()
    rows = all_papers(session)
    chosen: dict[str, dict[str, Any]] = {}
    for spec in args.papers:
        row = resolve_paper(rows, spec)
        chosen.setdefault(str(row["id"]), row)
    target = normalize_collection_name(args.to)
    moving = [row for row in chosen.values() if normalize_collection_name(str(row.get("collection_name", ""))) != target]
    if not moving:
        out.emit({"moved": 0, "created": [], "to": target}, f"すべて「{folder_label(target)}」にあります。移動する論文はありません。")
        return 0
    moves = [{"paper_id": str(row["id"]), "to": target} for row in moving]
    expected = {str(row["id"]): str(row.get("collection_name", "")) for row in moving}
    result = apply_moves(session, moves, expected)
    created = result.get("created") or []
    text = f"{result.get('moved', len(moving))} 件を「{folder_label(target)}」に移動しました。"
    if created:
        text += f"\n新しいフォルダー: {', '.join(created)}"
    out.emit({**result, "to": target, "papers": [str(row["id"]) for row in moving]}, text)
    return 0


# --- organize ---

def proposal_text(proposal: dict[str, Any]) -> str:
    moves = proposal.get("moves") or []
    lines: list[str] = []
    if moves:
        rows = [[f"{folder_label(str(move.get('from', '')))} → {folder_label(str(move.get('to', '')))}", str(move.get("title", ""))]
                for move in moves]
        lines.append(table(rows, ["移動元 → 移動先", "タイトル"]))
    else:
        lines.append("移動する論文はありません。")
    folders = proposal.get("folders") or []
    if folders:
        lines.append("")
        lines.append("フォルダー:")
        for folder in folders:
            mark = "新規" if folder.get("new") else "既存"
            reason = f"  {folder['reason']}" if folder.get("reason") else ""
            lines.append(f"  [{mark}] {folder.get('name', '')}{reason}")
    if proposal.get("message"):
        lines += ["", f"AI のコメント: {proposal['message']}"]
    usage = usage_line(proposal.get("usage"))
    if usage:
        lines.append(usage)
    return "\n".join(lines)


def cmd_organize(ctx: Context) -> int:
    out, args = ctx.out, ctx.args
    session = ctx.session()
    body: dict[str, Any] = {"source": normalize_collection_name(args.folder or "")}
    if args.papers:
        rows = all_papers(session)
        body["paper_ids"] = list(dict.fromkeys(str(resolve_paper(rows, spec)["id"]) for spec in args.papers))
    for key, value in (("instruction", args.instruction), ("feedback", args.feedback), ("model", args.model),
                       ("effort", args.effort)):
        if value:
            body[key] = value
    if args.previous:
        try:
            previous = json.loads(Path(args.previous).read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise CliError(f"前回の案（{args.previous}）を読めません: {error}", EXIT_USAGE) from None
        body["previous"] = previous.get("proposal", previous) if isinstance(previous, dict) else previous

    def submit(current: Session) -> str:
        return str(current.post("/api/collections/organize", body)["job_id"])

    job = finish_job(ctx, submit, resume=not args.no_resume)
    proposal = job.result if isinstance(job.result, dict) else {}
    if args.save:
        try:
            atomic_write_json(Path(args.save), proposal)
        except OSError as error:
            raise CliError(f"案を保存できませんでした（{args.save}）: {error}") from None
    moves = proposal.get("moves") or []
    data: dict[str, Any] = {"proposal": proposal, "applied": None}
    apply_now, shown = False, False
    if moves and not args.dry_run:
        if args.yes:
            apply_now = True
        elif out.can_prompt:
            out.text(proposal_text(proposal))
            shown = True
            if not out.confirm("この内容で適用しますか? [y/N] "):
                out.info("適用しませんでした。")
                return 1
            apply_now = True
        else:
            out.emit(data, proposal_text(proposal))
            out.error("対話できない環境のため適用しませんでした。--yes で適用、--dry-run で案の表示だけにできます。")
            return 1
    if not apply_now:  # --dry-run, or nothing to move.
        out.emit(data, proposal_text(proposal))
        return 0
    result = apply_moves(session, [{"paper_id": m["paper_id"], "to": m["to"]} for m in moves],
                         proposal.get("expected") or {})
    data["applied"] = result
    created = result.get("created") or []
    text = f"{result.get('moved', len(moves))} 件を移動しました。"
    if created:
        text += "\n新しいフォルダー: " + ", ".join(created)
    out.emit(data, text if shown else proposal_text(proposal) + "\n\n" + text)
    return 0


# --- translate ---

def cmd_translate(ctx: Context) -> int:
    out, args = ctx.out, ctx.args
    session = ctx.session()
    paper = resolve_paper(all_papers(session), args.paper)
    paper_id = str(paper["id"])
    if args.plan:
        query = {key: value for key, value in (("pages", args.pages), ("model", args.model)) if value}
        plan = session.get(f"/api/papers/{paper_id}/translation-plan", query=query or None)
        lines = [f"論文: {paper.get('title', '')}", f"モデル: {plan.get('model', '')}"]
        selected = plan.get("selected_pages") or []
        lines.append(f"対象ページ: {page_ranges(selected) or 'なし'}（{len(selected)} ページ）")
        for key, label in (("reusable_pages", "保存済みの訳を再利用"), ("pending_pages", "AI に送る"),
                           ("retranslated_pages", "表示中の訳を訳し直す")):
            pages = plan.get(key) or []
            lines.append(f"  {label}: {page_ranges(pages) or 'なし'}")
        if plan.get("previous_models"):
            lines.append(f"  前回のモデル: {', '.join(plan['previous_models'])}")
        lines.append("AI を使います。" if plan.get("needs_ai") else "AI は使いません（保存済みの訳から PDF を作り直すだけです）。")
        out.emit({"paper_id": paper_id, "plan": plan}, "\n".join(lines))
        return 0
    body = {key: value for key, value in (("pages", args.pages), ("model", args.model), ("effort", args.effort)) if value}

    def submit(current: Session) -> str:
        return str(current.post(f"/api/papers/{paper_id}/translate", body)["job_id"])

    if args.no_wait:
        job_id = submit(session)
        out.emit({"job_id": job_id, "paper_id": paper_id}, f"翻訳を開始しました（ジョブ {job_id}）。")
        return 0
    job = finish_job(ctx, submit, resume=not args.no_resume)
    result = job.result if isinstance(job.result, dict) else {}
    translated = result.get("translated_pages") or []
    lines = [f"翻訳しました: {paper.get('title', '')}",
             f"  翻訳したページ: {page_ranges(translated) or 'なし'}（{len(translated)} ページ）  モデル: {result.get('model', '')}"]
    skipped = result.get("skipped_pages") or []
    if skipped:
        lines.append(f"  元のままのページ: {page_ranges(skipped)}")
    for page, message in sorted((result.get("page_errors") or {}).items(), key=lambda item: int(item[0]) if str(item[0]).isdigit() else 0):
        lines.append(f"  p.{page}: {message}")
    usage = usage_line(result.get("usage"))
    if usage:
        lines.append("  " + usage)
    out.emit({"paper_id": paper_id, "result": result}, "\n".join(lines))
    return 0


# --- job ---

def job_text(job: dict[str, Any]) -> str:
    status = str(job.get("status", ""))
    lines = [f"ジョブ: {job.get('job_id')}", f"種類: {job.get('kind')}",
             f"状態: {JOB_STATUS_LABELS.get(status, status)}"]
    if job.get("paper_id"):
        lines.append(f"論文: {job['paper_id']}")
    if job.get("done") is not None and job.get("total"):
        lines.append(f"進捗: {job['done']}/{job['total']}")
    if job.get("message"):
        lines.append(f"内容: {job['message']}")
    if job.get("error"):
        lines.append(f"エラー: {job['error']}")
    if job.get("result") is not None:
        lines.append("結果: " + json.dumps(job["result"], ensure_ascii=False, indent=2))
    return "\n".join(lines)


def cmd_job_list(ctx: Context) -> int:
    jobs = ctx.session(spawn=False).get("/api/jobs")
    ctx.out.emit(jobs, jobs_table(jobs) if jobs else "実行中のジョブはありません。")
    return 0


def find_job(session: Session, spec: str) -> dict[str, Any]:
    """The job `spec` names: its ID, or the start of a running job's ID."""
    try:
        data = session.get("/api/jobs/" + urllib.parse.quote(spec, safe=""))
    except ApiError as error:
        if error.status != 404:
            raise
        running = [job for job in session.get("/api/jobs") if str(job.get("job_id", "")).startswith(spec)]
        if len(running) != 1:
            raise CliError("ジョブが見つかりません: " + spec) from None
        return running[0]
    return data


def cmd_job_show(ctx: Context) -> int:
    session = ctx.session(spawn=False)
    job = find_job(session, ctx.args.job_id)
    if ctx.args.wait and job.get("running"):
        # Somebody else's job: Ctrl+C stops the waiting, never the job.
        info = run_job(session, lambda _session: str(job["job_id"]), out=ctx.out, reconnects=0,
                       cancel_on_interrupt=False)
        job = info.raw
    ctx.out.emit(job, job_text(job))
    # With --wait the exit code is the job's outcome (also for one that had ended already); without it, that
    # the question was answered.
    return 1 if ctx.args.wait and job.get("status") != "succeeded" else 0


def cmd_job_cancel(ctx: Context) -> int:
    session = ctx.session(spawn=False)
    job = find_job(session, ctx.args.job_id)
    session.post(f"/api/jobs/{urllib.parse.quote(str(job['job_id']), safe='')}/cancel")
    ctx.out.emit({"job_id": job["job_id"], "status": "cancelling"}, f"ジョブ {job['job_id']} の中止を依頼しました。")
    return 0


# --- server ---

STOP_WAIT = 15.0
STOP_TIMEOUT = 40.0  # /shutdown answers once the jobs have stopped (up to 20 s) and the requests finished.


def cmd_server_stop(ctx: Context) -> int:
    out = ctx.out
    try:
        session = ctx.session(spawn=False)
    except CliError as error:
        if error.exit_code != EXIT_NO_SIDECAR:
            raise
        out.emit({"running": False, "stopped": False}, "起動している sidecar はありません。")
        return 0
    target: Target = session.target
    if target.launcher != "cli":
        label = LAUNCHER_LABELS.get(target.launcher or "", target.launcher or "不明")
        raise CliError(f"この sidecar は {label} のものなので止められません。Papeer のウィンドウを閉じてください。")
    session.post("/shutdown", timeout=STOP_TIMEOUT, reconnect=False)
    gone = True
    if ctx.connector is not None:
        gone = ctx.connector.wait_gone(target, STOP_WAIT)
    out.emit({"running": True, "stopped": gone, "pid": target.pid},
             "ヘッドレスの Papeer を停止しました。" if gone else "停止を依頼しました（まだ終了処理中です）。")
    return 0 if gone else 1
