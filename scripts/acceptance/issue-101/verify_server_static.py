"""Run the Server's narrow static checks on every changed Python file."""
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve(strict=True)
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], text=True).strip() == str(root)
tracked = subprocess.check_output(['git', '-C', str(root), 'diff', '--name-only', '--diff-filter=AM', '-z'], text=True)
untracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--others', '--exclude-standard', '-z'], text=True)
files = sorted({name for name in (tracked + '\0' + untracked).split('\0') if name.endswith('.py')})
assert files
print('\n'.join(files), flush=True)
for arguments in (['check'], ['format', '--check']):
    subprocess.run([sys.executable, '-m', 'ruff', *arguments, *files], cwd=root, check=True)
