# Run only after final source review and installation, from repository root.
# Capture a new exclusive snapshot; never overwrite the draft baseline.
from pathlib import Path
import hashlib, json, sys
root = Path.cwd()
if len(sys.argv) != 2:
    raise SystemExit('usage: python frontend/scripts/capture-canonical-pdf-source-manifest.py <new output manifest path>')
destination = (root / sys.argv[1]).resolve()
output = (root / 'output').resolve()
if not destination.is_relative_to(output):
    raise SystemExit('destination must be within output')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
files = {}
def visit(rel):
    p = root / rel
    if p.is_symlink(): raise RuntimeError(f'symlink in source scope: {rel}')
    if p.is_dir():
        for child in sorted(p.iterdir(), key=lambda x: x.name): visit(rel + '/' + child.name)
    elif p.is_file(): files[rel] = sha(p)
    else: raise RuntimeError(f'unsupported source entry: {rel}')
# Re-enumerate top-level frontend files as well as every tree; reject new files only if snapshot changes during the run.
roots = sorted(['frontend/e2e','frontend/scripts','frontend/src','frontend/tests','tests/fixtures','tests/test_edit_repository.py'] +
    ['frontend/' + p.name for p in (root / 'frontend').iterdir() if p.is_file() and p.name != 'tsconfig.node.tsbuildinfo'])
for rel in roots: visit(rel)
with destination.open('x', encoding='utf-8', newline='\n') as out:
    json.dump({'schema': 1, 'roots': roots, 'files': files}, out, indent=2)
    out.write('\n')
print(f'{destination}: sha256={sha(destination)} files={len(files)}')
