"""`python -m papeer.cli` (the packaged papeer-cli.exe runs this file)."""
import sys

from papeer.cli.main import main

if __name__ == "__main__":
    sys.exit(main())
