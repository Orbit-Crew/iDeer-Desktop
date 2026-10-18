"""Verify all unchanged migration sources against pinned upstream Git blobs."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "resources/provenance/runtime-source.json").read_text())
for path, expected in manifest["files"].items():
    if path in manifest["modified"]:
        continue
    data = (root / path).read_bytes().replace(b"\r\n", b"\n")
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != expected:
        raise SystemExit(f"Upstream source changed without a migration record: {path}")
print(f"Verified pinned Runtime sources from {manifest['commit']}")
