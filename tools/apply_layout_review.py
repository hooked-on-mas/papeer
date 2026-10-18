"""Apply inspected fresh review pages to the library, with backups."""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    # `python tools/apply_layout_review.py` puts only tools/ on the path.
    sys.path.append(str(ROOT))

from tools.review_publish import apply_review

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--papers', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    parser.add_argument('--case', action='append')
    args = parser.parse_args()
    for result in apply_review(args.papers, args.review, args.case):
        print(result)
