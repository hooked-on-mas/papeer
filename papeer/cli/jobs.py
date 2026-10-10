"""Running a job to its end: start it, show how far it is, cancel it on Ctrl+C, and start over when the
sidecar it ran on went away.

A job lives in one sidecar's memory. The sidecar the CLI started leaves when idle and the window's takes
the library over from it (cancelling its jobs without the user's 中止, sidecar/instance.py): in both cases
the job we wait on is gone with its sidecar. Telling that apart from a 中止 in the window is what
`Session.gone` is for: when the sidecar we talked to no longer serves the library, the request is sent
again to the one that does (at most `reconnects` times). That is safe because the work is restartable: a
translation reuses its cache, an import skips the PDFs already in the library (by sha256), an organize
only proposes.
"""
from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any, Callable

from papeer.cli.client import CLOSING_CODE, ApiError, CliError, ConnectionLost, Session
from papeer.cli.output import Output

POLL_INTERVAL = 0.5
POLL_TIMEOUT = 10.0
# After a cancel: how long to wait for the job to stop before giving up on it.
CANCEL_WAIT = 30.0
# A job that ends cancelled that we did not ask for: how long the sidecar may take to be gone for good (it
# answers a few seconds after /shutdown has stopped the jobs) before it is taken for a 中止 in the window.
GONE_GRACE = 5.0
# How long to look for another sidecar to take the job over before starting one.
RECONNECT_PATIENCE = 3.0
# Polls in a row that get no answer from a sidecar that is still there (busy, or its port blocked).
MAX_SILENT_POLLS = 20
EXIT_INTERRUPTED = 130


class Interrupted(CliError):
    """The user stopped the command (Ctrl+C): exit code 130."""

    def __init__(self, message: str = "中止しました。") -> None:
        super().__init__(message, EXIT_INTERRUPTED)


class _Lost(Exception):
    """The sidecar the job ran on is gone."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class JobInfo:
    """A job as GET /api/jobs/{job_id} tells it (sidecar/job_types.JobInfo)."""
    job_id: str
    kind: str
    status: str
    message: str
    done: int | None
    total: int | None
    running: bool
    paper_id: str | None
    result: Any
    error: str | None
    raw: dict[str, Any]
    # How many times run_job started the work again on another sidecar (the work of the earlier attempts that
    # was done shows as already there the second time: an import reports those PDFs as duplicates).
    restarts: int = 0

    @classmethod
    def from_api(cls, data: Any) -> "JobInfo":
        if not isinstance(data, dict) or not isinstance(data.get("job_id"), str):
            raise CliError("sidecar のジョブの応答を読めませんでした。")
        return cls(job_id=data["job_id"], kind=str(data.get("kind") or ""), status=str(data.get("status") or ""),
                   message=str(data.get("message") or ""), done=data.get("done"), total=data.get("total"),
                   running=bool(data.get("running")), paper_id=data.get("paper_id"), result=data.get("result"),
                   error=data.get("error"), raw=data)

    @property
    def succeeded(self) -> bool:
        return self.status == "succeeded"


def require_success(job: JobInfo) -> JobInfo:
    """`job` when it succeeded; otherwise the failure as a CliError (exit 1) with the sidecar's own text."""
    if job.succeeded:
        return job
    if job.status == "cancelled":
        raise CliError(job.error or "ジョブが中止されました（Papeer の画面で中止された可能性があります）。")
    raise CliError(job.error or "ジョブが失敗しました。")


def run_job(
    session: Session,
    submit: Callable[[Session], str],
    *,
    out: Output,
    sleep: Callable[[float], None] = time.sleep,
    reconnects: int = 2,
    clock: Callable[[], float] = time.monotonic,
    poll_interval: float | None = None,
    cancel_wait: float | None = None,
    gone_grace: float | None = None,
    cancel_on_interrupt: bool = True,
) -> JobInfo:
    """Start a job with `submit(session)` (returns its job id) and follow it until it ends.

    Returns the finished job whatever its outcome (see require_success); raises Interrupted (exit 130)
    after a Ctrl+C. `reconnects` is how many times the work is started again on another sidecar; 0 (--no-resume)
    reports the loss instead. `cancel_on_interrupt` False is for following a job somebody else started:
    Ctrl+C then only stops the waiting (exit 130) and the job goes on.
    """
    # Looked up now, so that a test can shorten them.
    poll_interval = POLL_INTERVAL if poll_interval is None else poll_interval
    cancel_wait = CANCEL_WAIT if cancel_wait is None else cancel_wait
    gone_grace = GONE_GRACE if gone_grace is None else gone_grace
    restarts = 0
    while True:
        job_id = submit(session)
        try:
            job = _follow(session, job_id, out, sleep, clock, poll_interval, cancel_wait, gone_grace,
                          cancel_on_interrupt)
            job.restarts = restarts
            return job
        except _Lost as lost:
            if restarts >= reconnects:
                raise CliError(f"{lost.reason}。"
                               + ("" if reconnects == 0 else f"再接続は{reconnects}回までです。")) from None
            restarts += 1
            out.info(f"{lost.reason}。接続し直して同じ処理をやり直します…")
            if not session.reconnect(RECONNECT_PATIENCE):
                raise CliError("sidecar に接続し直せませんでした。", 3) from None


def _follow(session: Session, job_id: str, out: Output, sleep: Callable[[float], None], clock: Callable[[], float],
            poll_interval: float, cancel_wait: float, gone_grace: float, cancel_on_interrupt: bool = True) -> JobInfo:
    cancel_asked_at: float | None = None
    silent = 0
    while True:
        try:
            try:
                job = JobInfo.from_api(session.get(f"/api/jobs/{job_id}", timeout=POLL_TIMEOUT, reconnect=False))
            except ConnectionLost as error:
                if session.gone():
                    raise _Lost("sidecar が終了しました") from None
                silent += 1
                if silent >= MAX_SILENT_POLLS:
                    raise CliError(str(error)) from None
                sleep(poll_interval)
                continue
            except ApiError as error:
                if error.code == CLOSING_CODE:
                    raise _Lost("sidecar が終了処理に入りました") from None
                raise
            silent = 0
            if not job.running:
                out.finish_progress()
                if cancel_asked_at is not None and not job.succeeded:
                    raise Interrupted(job.error or "中止しました。")
                if job.status == "cancelled" and cancel_asked_at is None and _went_away(session, sleep, clock, gone_grace):
                    raise _Lost("Papeer が別のプロセスに引き継がれたか終了しました")
                return job
            out.progress(job.message, job.done, job.total)
            if cancel_asked_at is not None and clock() - cancel_asked_at >= cancel_wait:
                raise Interrupted("中止を依頼しましたが、ジョブがまだ止まっていません。")
            sleep(poll_interval)
        except KeyboardInterrupt:
            if not cancel_on_interrupt:
                out.finish_progress()
                raise Interrupted("待つのをやめました（ジョブはそのまま続きます）。") from None
            if cancel_asked_at is not None:
                raise Interrupted("強制終了しました（ジョブは sidecar 側で止まるまで残ることがあります）。") from None
            cancel_asked_at = clock()
            out.finish_progress()
            out.info("中止しています…（もう一度 Ctrl+C で強制終了）")
            try:
                session.post(f"/api/jobs/{job_id}/cancel", reconnect=False)
            except CliError:
                pass  # Already over, or unreachable: the polling says which.
            except KeyboardInterrupt:
                raise Interrupted("強制終了しました（ジョブは sidecar 側で止まるまで残ることがあります）。") from None


def _went_away(session: Session, sleep: Callable[[float], None], clock: Callable[[], float], grace: float) -> bool:
    """Whether the sidecar we talked to is (about to be) gone: a job it cancelled that the user did not."""
    deadline = clock() + grace
    while True:
        if session.gone():
            return True
        if clock() >= deadline:
            return False
        sleep(0.25)
