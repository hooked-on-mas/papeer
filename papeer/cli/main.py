"""papeer-cli: argument parsing, the connection, and the exit code.

Exit codes: 0 success, 1 failure, 2 wrong usage, 3 no sidecar to talk to, 130 interrupted (Ctrl+C).

`main` takes what a test replaces: `transport` (a papeer.cli.client.Transport used as the connection, so
nothing is looked up or started), `connector` (to test finding, starting and reconnecting) and `out`.
"""
from __future__ import annotations

import argparse
import math
import sys
from typing import Any, NoReturn, Sequence

from papeer.cli import commands
from papeer.cli.client import CliError, Session, Target, Transport
from papeer.cli.connect import DEFAULT_IDLE, Connector, Options
from papeer.cli.output import Output

PROG = "papeer-cli"
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130

_TRANSLATED_ERRORS = (
    ("the following arguments are required: ", "必須の引数がありません: "),
    ("unrecognized arguments: ", "認識できない引数があります: "),
    ("expected one argument", "値を 1 つ指定してください"),
)


class _Formatter(argparse.HelpFormatter):
    def add_usage(self, usage: Any, actions: Any, groups: Any, prefix: str | None = None) -> None:
        super().add_usage(usage, actions, groups, prefix if prefix is not None else "使い方: ")


class _Parser(argparse.ArgumentParser):
    """argparse with Japanese headings and usage errors that exit with 2 as one line on stderr."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("formatter_class", _Formatter)
        kwargs["add_help"] = False
        super().__init__(*args, **kwargs)
        self._positionals.title = "引数"
        self._optionals.title = "オプション"
        self.add_argument("-h", "--help", action="help", default=argparse.SUPPRESS, help="このヘルプを表示して終了します")

    def error(self, message: str) -> NoReturn:
        for english, japanese in _TRANSLATED_ERRORS:
            message = message.replace(english, japanese)
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{self.prog}: エラー: {message}\n")
        raise SystemExit(EXIT_USAGE)


def _global_options(parser: argparse.ArgumentParser, *, subcommand: bool) -> None:
    """The options every command takes, before or after its name. On a subcommand parser they have no
    default, so that giving them in one place does not undo giving them in the other."""
    def default(value: Any) -> Any:
        return argparse.SUPPRESS if subcommand else value

    group = parser.add_argument_group("共通のオプション")
    group.add_argument("--json", action="store_true", default=default(False),
                       help="結果を JSON で標準出力に出します（進捗や注意は標準エラー出力）")
    group.add_argument("--quiet", action="store_true", default=default(False), help="進捗と補足のメッセージを出しません")
    group.add_argument("--data-dir", metavar="DIR", default=default(None),
                       help="ライブラリのフォルダー（既定: 環境変数 PAPEER_DATA_DIR、なければ標準の場所）")
    group.add_argument("--no-spawn", action="store_true", default=default(False),
                       help="Papeer が起動していなくても、ヘッドレスの sidecar を起動しません（終了コード 3）")
    group.add_argument("--no-resume", action="store_true", default=default(False),
                       help="sidecar が終了・引き継ぎされても、同じ処理をやり直さずに失敗として終わります")
    group.add_argument("--idle", type=float, metavar="SEC", default=default(DEFAULT_IDLE),
                       help=f"起動したヘッドレス sidecar が、何もなければ終了するまでの秒数（既定 {DEFAULT_IDLE:g}）")
    group.add_argument("--url", metavar="URL", default=default(None),
                       help="接続先の sidecar の URL（環境変数 PAPEER_CLI_URL。--token か PAPEER_TOKEN とともに）")
    group.add_argument("--token", metavar="TOKEN", default=default(None), help="接続先の認証トークン（環境変数 PAPEER_TOKEN）")


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog=PROG,
        description="Papeer をコマンドラインから操作します。Papeer のウィンドウが開いていればそこへ、"
                    "なければヘッドレスの sidecar を自動で起動して接続します（何もしなければ自分で終了します）。",
        epilog="終了コード: 0 成功 / 1 失敗 / 2 使い方の誤り / 3 接続先なし / 130 中断（Ctrl+C）")
    _global_options(parser, subcommand=False)
    sub = parser.add_subparsers(dest="command", metavar="コマンド", parser_class=_Parser)

    def command(parent: Any, name: str, handler: Any, help_text: str) -> argparse.ArgumentParser:
        child = parent.add_parser(name, help=help_text, description=help_text)
        child.set_defaults(handler=handler)
        _global_options(child, subcommand=True)
        return child

    command(sub, "status", commands.cmd_status, "接続先（ウィンドウ／ヘッドレス）と実行中のジョブを表示します")

    add = command(sub, "add", commands.cmd_add, "PDF をライブラリに取り込みます（* などはこちらで展開します）")
    add.add_argument("paths", nargs="+", metavar="PATH", help="PDF のパス、パターン、または -r を付けたフォルダー")
    add.add_argument("-f", "--folder", metavar="FOLDER", help="取り込み先のフォルダー（なければ作ります）")
    add.add_argument("-r", "--recursive", action="store_true", help="フォルダーの中の PDF も（サブフォルダーまで）取り込みます")
    add.add_argument("--no-wait", action="store_true", help="取り込みを始めたらすぐ終了します（ジョブ ID を表示）")

    ls = command(sub, "ls", commands.cmd_ls, "論文の一覧を表示します")
    ls.add_argument("folder", nargs="?", metavar="FOLDER",
                    help='そのフォルダーに直接入っている論文だけ（"" で未分類）。省略するとすべて')
    ls.add_argument("-q", "--query", metavar="QUERY", help="タイトルなどを検索します")
    ls.add_argument("--all", action="store_true", help="FOLDER のサブフォルダーの論文も含めます")

    folder = command(sub, "folder", None, "フォルダーを操作します")
    folder_sub = folder.add_subparsers(dest="folder_command", metavar="操作", required=True, parser_class=_Parser)
    command(folder_sub, "list", commands.cmd_folder_list, "フォルダーの一覧（論文数つき）を表示します")
    create = command(folder_sub, "create", commands.cmd_folder_create, "フォルダーを作ります")
    create.add_argument("name", metavar="NAME", help='フォルダーの名前（"親 / 子" で階層）')
    rename = command(folder_sub, "rename", commands.cmd_folder_rename, "フォルダーの名前を変えます")
    rename.add_argument("old", metavar="OLD", help="今の名前（階層は「親 / 子」）")
    rename.add_argument("new", metavar="NEW", help="新しい名前（階層は含めない最後の部分）")
    delete = command(folder_sub, "delete", commands.cmd_folder_delete,
                     "フォルダーを削除します（中の論文は未分類に移り、元に戻せます）")
    delete.add_argument("name", metavar="NAME", help="削除するフォルダー（サブフォルダーごと）")
    delete.add_argument("-y", "--yes", action="store_true", help="確認せずに削除します")
    restore = command(folder_sub, "restore", commands.cmd_folder_restore, "削除したフォルダーを元に戻します")
    restore.add_argument("token", metavar="TOKEN", help="削除したときに表示された復元用のトークン")

    mv = command(sub, "mv", commands.cmd_mv, "論文をフォルダーに移動します（まとめて 1 回の操作）")
    mv.add_argument("papers", nargs="+", metavar="PAPER", help="論文 ID（6 文字以上の先頭部分でも可）")
    mv.add_argument("--to", required=True, metavar="FOLDER", help='移動先のフォルダー（なければ作ります。"" で未分類）')

    organize = command(sub, "organize", commands.cmd_organize,
                       "AI にフォルダー分けの案を作らせ、確認してから適用します")
    organize.add_argument("folder", nargs="?", metavar="FOLDER",
                          help="整理するフォルダー（直下の論文だけ）。省略すると未分類")
    organize.add_argument("--papers", nargs="+", metavar="ID", help="FOLDER の代わりに、これらの論文を対象にします")
    organize.add_argument("--instruction", metavar="TEXT", help="AI への指示（例: 分野別に分けて）")
    organize.add_argument("--feedback", metavar="TEXT", help="前回の案への修正の依頼（--previous と組み合わせます）")
    organize.add_argument("--previous", metavar="FILE", help="--save で保存した前回の案（作り直しの土台）")
    organize.add_argument("--model", metavar="M", help="この実行だけ使うモデル")
    organize.add_argument("--effort", metavar="E", help="この実行だけ使う推論の強さ")
    organize.add_argument("-y", "--yes", action="store_true", help="確認せずに案を適用します")
    organize.add_argument("--dry-run", action="store_true", help="案を表示するだけで適用しません")
    organize.add_argument("--save", metavar="FILE", help="案を JSON として保存します")

    translate = command(sub, "translate", commands.cmd_translate, "論文を翻訳します（AI の設定が必要です）")
    translate.add_argument("paper", metavar="PAPER", help="論文 ID（6 文字以上の先頭部分でも可）")
    translate.add_argument("-p", "--pages", metavar="PAGES", help="翻訳するページ（例: 1-3,5）。省略すると全ページ")
    translate.add_argument("--model", metavar="M", help="この実行だけ使うモデル")
    translate.add_argument("--effort", metavar="E", help="この実行だけ使う推論の強さ")
    translate.add_argument("--plan", action="store_true", help="翻訳せず、どのページを AI に送るかだけ表示します")
    translate.add_argument("--no-wait", action="store_true", help="翻訳を始めたらすぐ終了します（ジョブ ID を表示）")

    job = command(sub, "job", None, "ジョブを操作します")
    job_sub = job.add_subparsers(dest="job_command", metavar="操作", required=True, parser_class=_Parser)
    command(job_sub, "list", commands.cmd_job_list, "実行中のジョブを表示します")
    show = command(job_sub, "show", commands.cmd_job_show, "ジョブの状態を表示します")
    show.add_argument("job_id", metavar="ID")
    show.add_argument("--wait", action="store_true", help="終わるまで待ちます（失敗なら終了コード 1）")
    cancel = command(job_sub, "cancel", commands.cmd_job_cancel, "ジョブの中止を依頼します")
    cancel.add_argument("job_id", metavar="ID")

    server = command(sub, "server", None, "sidecar を操作します")
    server_sub = server.add_subparsers(dest="server_command", metavar="操作", required=True, parser_class=_Parser)
    command(server_sub, "stop", commands.cmd_server_stop,
            "CLI が起動したヘッドレスの sidecar を停止します（ウィンドウのものは止めません）")

    setup = command(sub, "setup-path", commands.cmd_setup_path,
                    "インストールした papeer-cli をターミナルから呼べるようにします（Windows: ユーザーの PATH に追加）")
    setup.add_argument("--remove", action="store_true", help="追加した PATH を削除します（macOS・Linux では削除用のコマンドを表示）")
    return parser


def main(argv: Sequence[str] | None = None, *, transport: Transport | None = None, out: Output | None = None,
         connector: Connector | None = None) -> int:
    out = out or Output.for_process()
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as stop:
        return stop.code if isinstance(stop.code, int) else (0 if stop.code is None else EXIT_USAGE)
    if getattr(args, "handler", None) is None:
        parser.print_help(sys.stderr)
        return EXIT_USAGE
    if not math.isfinite(args.idle) or args.idle <= 0:
        sys.stderr.write(f"{PROG}: エラー: --idle には 0 より大きい有限の秒数を指定してください\n")
        return EXIT_USAGE
    out.json_mode = bool(args.json)
    out.quiet = bool(args.quiet)
    session = None
    if transport is not None:
        session = Session(transport, Target(base_url="injected"))
    elif connector is None:
        options = Options(url=args.url, token=args.token, data_dir=args.data_dir, no_spawn=args.no_spawn, idle=args.idle)
        connector = Connector(options, notify=out.info)
    ctx = commands.Context(out, args, connector=connector, session=session)
    try:
        return int(args.handler(ctx))
    except KeyboardInterrupt:
        out.finish_progress()
        out.error("中止しました。")
        return EXIT_INTERRUPTED
    except CliError as error:
        out.error(error.message, error.code)
        return error.exit_code
    except Exception as error:  # noqa: BLE001 - the last resort of a command line: one line, exit 1.
        out.error(f"予期しないエラーが発生しました（{type(error).__name__}: {error}）。")
        return 1
