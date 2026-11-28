"""Registry-owned, Library-specific enrollment retirement; callers hold its lock."""
from dataclasses import dataclass, field
import threading


@dataclass
class JobToken:
    sequence: int
    barriers_at_start: frozenset[str]
    cancelled: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)


@dataclass
class Retirement:
    key: str
    sequence: int
    waiters: tuple[threading.Event, ...]
    executing: bool = True


class PermissionJobs:
    def __init__(self):
        self.closed = False
        self.sequence = 0
        self.revoked: dict[str, int] = {}
        self.barriers: dict[str, Retirement] = {}
        self.enrollments: dict[str, dict] = {}

    def capture(self):
        token = JobToken(self.sequence, frozenset(self.barriers))
        if self.closed: token.cancelled.set()
        return token

    def close(self):
        """Irreversible process-lifetime maintenance fence; registry lock required."""
        self.closed = True
        tokens = tuple(job['jobToken'] for job in self.enrollments.values())
        for token in tokens: token.cancelled.set()
        return tokens

    def retired(self, token: JobToken, key, kind):
        return (self.closed or token.cancelled.is_set() or key is not None and (
            self.revoked.get(key, 0) > token.sequence
            or kind == 'enroll' and (key in self.barriers or key in token.barriers_at_start)))

    def reserve(self, key):
        existing = self.barriers.get(key)
        if existing is not None:
            if existing.executing: return None
            existing.executing = True
            return existing
        self.sequence += 1
        self.revoked[key] = self.sequence
        waiters = []
        for job in self.enrollments.values():
            if job.get('enrollmentKey') != key: continue
            token = job['jobToken']
            token.cancelled.set()
            waiters.append(token.done)
        retirement = Retirement(key, self.sequence, tuple(waiters))
        self.barriers[key] = retirement
        return retirement

    def finish(self, retirement: Retirement, *, settled):
        if self.barriers.get(retirement.key) is not retirement: return
        if settled: del self.barriers[retirement.key]
        else: retirement.executing = False
