"""Work B7-g: the interruption points P0-P9 of the staging writer (DESIGN-r161-b7-staging.md 5.2) and the child-process driver.

Shared by `test_native_staging_resume.py` (the parent) and the child processes it starts. Nothing here is imported by product code and the
product has no test branch: a point is a wrapper around an existing function of `sidecar.migrations.staging` or of the store, installed by
the test (the writer's `_boundary(token, stage)` hook, named in IMPL-r161-b7f 10.3, or the store function whose transaction is the point).

A point's `action` is what the test wants to happen there: raise (the in-process matrix), `os._exit(70)` (a child that dies on the spot, with no
`finally` and no rollback of an open transaction), or announce itself and wait for the parent to kill the child (the OS-kill case: only a
child the test itself started, through its own Popen handle).

The child is a fresh Python process (`child_main`) that does what a restarted app does for a COLD run: it takes the Library lock, registers the
Library the way the `runtime` fixture of the tests does (a test-only registry), and calls `staging.build`. It runs only in the isolated
environment the parent hands it (the parent asserts that first); it never touches a real folder.
"""
from collections import namedtuple
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parents[3]
FRONTEND = REPO / 'frontend'
BRIDGE = FRONTEND / 'tests' / 'migrations' / 'stagingConversionBridge.ts'
TESTS = Path(__file__).resolve().parent
EXIT_CODE = 70

Point = namedtuple('Point', 'id where state phase install')


class Interrupted(Exception):
    """What the in-process matrix raises at a point (the writer wraps it as `staging-unavailable`, never echoing it)."""


def _wrap_boundary(stage, nth):
    def install(action):
        from sidecar.migrations import staging
        real, count = staging._boundary, [0]

        def wrapper(token, name):
            if name == stage:
                count[0] += 1
                if count[0] == nth:
                    action()
            real(token, name)

        staging._boundary = wrapper
        return lambda: setattr(staging, '_boundary', real)
    return install


def _wrap(module_name, name, *, when, nth=1, only=None):
    """`action` runs before (when='before') or after (when='after') the real function's `nth` call (that satisfies `only(args, kwargs)`)."""
    def install(action):
        import importlib
        module = importlib.import_module(module_name)
        real, count = getattr(module, name), [0]

        def wrapper(*args, **kwargs):
            hit = only is None or only(args, kwargs)
            if hit:
                count[0] += 1
            if hit and count[0] == nth and when == 'before':
                action()
            result = real(*args, **kwargs)
            if hit and count[0] == nth and when == 'after':
                action()
            return result

        setattr(module, name, wrapper)
        return lambda: setattr(module, name, real)
    return install


STORE = 'papeer.core.migrations.legacy_staging_store'
STAGING = 'sidecar.migrations.staging'
_creating = lambda args, kwargs: kwargs.get('create') is True      # noqa: E731 - `_database_path(..., create=True)` is the first creation

# The fixture of the matrix has 2 resources (the PDF and one image), 5 units (the Library, the PDF, two Notebooks, the Markdown note).
POINTS = {point.id: point for point in (
    Point('P0-gather', 'before any source is read', 'absent', None, _wrap_boundary('gather', 1)),
    Point('P0-copy', 'inside the Library working copy (a killed process leaves its .analysis-* folder)', 'absent', None,
          _wrap(STAGING, 'extract_staging_rows', when='after')),
    Point('P0-validate', 'the plan is made and checked, nothing is written', 'absent', None, _wrap_boundary('validate', 1)),
    Point('P1-folder', 'the staging folder exists, no database yet', 'uninitialized', None,
          _wrap(STORE, '_database_path', when='after', only=_creating)),
    Point('P1-schema', 'the database exists with the schema not committed', 'uninitialized', None,
          _wrap(STORE, 'initialize_staging_schema', when='after')),
    Point('P2', 'T_init committed, no resource yet', 'resumable', 'initialized', _wrap_boundary('resource', 1)),
    Point('P3', 'one of two resources committed', 'resumable', 'initialized', _wrap_boundary('resource', 2)),
    Point('P4', 'the 2nd resource and its rows written, the transaction not committed', 'resumable', 'initialized',
          _wrap(STORE, 'put_provenance', when='after', nth=2)),
    Point('P5', 'every resource committed, no plan', 'resumable', 'resources', _wrap_boundary('plan', 1)),
    Point('P5-tx', 'the plan row written, the transaction not committed', 'resumable', 'resources', _wrap(STORE, 'put_plan', when='after')),
    Point('P6-0', 'T_plan committed, no unit', 'resumable', 'planned', _wrap_boundary('unit', 1)),
    Point('P6-2', 'two of five units committed', 'resumable', 'planned', _wrap_boundary('unit', 3)),
    Point('P6-tx', 'the 2nd unit written, the transaction not committed', 'resumable', 'planned', _wrap(STORE, 'put_unit', when='after', nth=2)),
    Point('P6-all', 'every unit committed, no checkpoint', 'resumable', 'units', _wrap_boundary('assemble', 1)),
    Point('P7', 'the checkpoint committed, the phase not moved', 'resumable', 'units', _wrap(STORE, 'mark_assembled', when='before')),
    Point('P8', 'assembled, not verified', 'resumable', 'assembled', _wrap_boundary('verify', 1)),
    Point('P8-tx', 'the verification row written, the transaction not committed', 'resumable', 'assembled',
          _wrap(STORE, 'put_verification', when='after')),
    Point('P9', 'verified, not sealed', 'resumable', 'verified', _wrap_boundary('seal', 1)),
    Point('P9-tx', 'the seal written, the transaction not committed', 'resumable', 'verified', _wrap(STORE, 'seal_run', when='after')),
    Point('P10', 'sealed (staged), the answer lost', 'staged', 'staged', _wrap(STAGING, '_seal', when='after')),
)}


# ---------------------------------------------------------------------------------------------------------------------
# the child
# ---------------------------------------------------------------------------------------------------------------------
def convert(data):
    """The real TypeScript converters through the test bridge (the same command as `test_native_staging_conversion_ts.run_bridge`)."""
    node = shutil.which('node')
    assert node, 'node is required'
    process = subprocess.Popen([node, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', str(BRIDGE)], cwd=FRONTEND,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    stdout, stderr = process.communicate(json.dumps(data), timeout=300)
    assert process.returncode == 0, stderr[-2000:]
    return json.loads(stdout)


def child_main(argv):
    """`argv`: root, run id, point id or `none`, mode (`exit`, `wait` or `none`). Prints one JSON line (the report or the refusal) when the
    build comes back; with mode `exit` the process dies at the point (`os._exit`), with mode `wait` it prints `AT <point>` and blocks on stdin."""
    root_text, run_id, point_id, mode = argv
    from papeer.core import paths
    from sidecar.lifecycle import instance
    from sidecar.migrations import census, staging
    root = census._root(paths.selected_data_directory())
    assert root == census._root(root_text), 'the child must see the same data folder as the parent'
    device = census._root(paths.device_directory())
    lock = instance.claim_library(root, 'dev', wait=0)
    assert lock.held
    census._controlled_roots[(root, device)] = (lock, census._identity(root), census._identity(device))   # the test-only registry, as the fixture does
    if point_id != 'none':
        def action():
            if mode == 'exit':
                os._exit(EXIT_CODE)
            print('AT ' + point_id, flush=True)
            sys.stdin.read()                                      # blocks until the parent kills this process (it never answers)
            os._exit(EXIT_CODE + 1)
        POINTS[point_id].install(action)
    try:
        result = {'report': staging.build(run_id, convert, timeout=900)}
    except ValueError as error:
        result = {'refused': list(error.args)}
    print(json.dumps(result, sort_keys=True), flush=True)


def child_command(root, run_id, point_id, mode):
    code = ('import sys; sys.path.insert(0, %r); import _staging_resume_points as m; m.child_main(sys.argv[1:])' % str(TESTS))
    return [sys.executable, '-B', '-c', code, str(root), run_id, point_id, mode]
