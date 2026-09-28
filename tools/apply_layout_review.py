"""Apply inspected fresh review pages to the library, with backups."""
import argparse
from pathlib import Path
from tools.review_publish import apply_review

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--papers', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    parser.add_argument('--case', action='append')
    args = parser.parse_args()
    for result in apply_review(args.papers, args.review, args.case):
        print(result)
