"""The command line client of Papeer (papeer-cli): talks to the sidecar over HTTP, standard library only.

It never opens the library itself: every command is a request to the sidecar that serves it (the window's,
or a headless one this client starts and that leaves by itself when idle), so the sidecar's job exclusion
and snapshot protection apply to the CLI as they do to the window. Keep this package free of the app's
heavy dependencies (fastapi, pymupdf, PIL, ...) and of the papeer modules that import them: a command line
that takes seconds to import is not one to type. tests/test_cli.py checks it.
"""
