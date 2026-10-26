"""Pair real devices for the provider fixture's synthetic regular accounts."""
from pathlib import Path

entry = Path(__file__).resolve().parents[1] / 'issue-100/profiles.py'
source = entry.read_text(encoding='utf-8')
before = "assert email == f't100-{label.lower()}@test.com'"
assert source.count(before) == 1
source = source.replace(before, "assert email == f't99-provider-{label.lower()}@test.com'")
before = "'local.files.list', 'local.files.read', 'local.files.search']"
assert source.count(before) == 1
source = source.replace(before, "'local.files.list', 'local.files.read', 'local.files.search', 'local.files.write']")
exec(compile(source, str(entry), 'exec'))
