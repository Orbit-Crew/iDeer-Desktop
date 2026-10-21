"""Record a validation command, complete output, duration and exit code."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cwd', type=Path, default=Path.cwd())
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command is required after --')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    start = time.monotonic()
    with args.output.with_suffix('.log').open('wb') as output:
        result = subprocess.run(command, cwd=args.cwd, stdout=output, stderr=subprocess.STDOUT)
    record = {'command': command, 'cwd': str(args.cwd.resolve()), 'started': started,
              'finished': datetime.now(timezone.utc).isoformat(),
              'seconds': round(time.monotonic() - start, 3), 'exitCode': result.returncode}
    args.output.with_suffix('.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps(record))
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
