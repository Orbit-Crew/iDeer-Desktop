"""Rebind copied, ignored venv entrypoints to an isolated Server checkout."""
from pathlib import Path
import sys

old, new = (Path(value).resolve(strict=True) for value in sys.argv[1:])
assert old != new and new.parent.name == '.codex-worktrees'
environment = (new / 'backend/.venv').resolve(strict=True)
assert environment == new / 'backend/.venv' and not environment.is_symlink()
paths = [*environment.joinpath('bin').iterdir()]
for site in environment.glob('lib/python*/site-packages'):
    paths.extend(site.glob('*.pth'))
    paths.extend(site.glob('__editable__*finder.py'))
changed = 0
for path in paths:
    if not path.is_file() or path.is_symlink():
        continue
    try:
        content = path.read_text(encoding='utf-8')
    except UnicodeError:
        continue
    updated = content.replace(str(old), str(new))
    if updated != content:
        path.write_text(updated, encoding='utf-8')
        changed += 1
print(f'Rebound {changed} copied environment files')
