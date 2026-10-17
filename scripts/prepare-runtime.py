"""Assemble the Windows runtime from the checked-in distribution lock."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    lock = json.loads((ROOT / "local-runtime/distribution.lock.json").read_text())
    cache = ROOT / ".cache/runtime-downloads"
    target = ROOT / ".runtime"
    cache.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".runtime-stage-", dir=ROOT))
    for item in lock["artifacts"]:
        archive = cache / item["name"]
        if not archive.exists():
            with urllib.request.urlopen(item["url"], timeout=120) as response:
                archive.write_bytes(response.read())
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"distribution hash mismatch: {archive.name}")
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(stage)
    # The isolated interpreter sees only its bundled stdlib and this folder.
    (stage / "python312._pth").write_text("python312.zip\n.\n", encoding="utf-8")
    shutil.copytree(ROOT / "local-runtime/core", stage / "core", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2(ROOT / "local-runtime/distribution.lock.json", stage)
    shutil.copy2(ROOT / "resources/provenance/runtime-source.json", stage / "source-manifest.json")
    shutil.copy2(ROOT / "local-runtime/LICENSE.upstream", stage / "LICENSE.ideer-runtime.txt")
    # Remove only this known build-output directory, after assembly succeeds.
    if target.is_symlink() or target.resolve().parent != ROOT:
        raise ValueError("unexpected runtime output path")
    if target.exists():
        shutil.rmtree(target)
    stage.rename(target)
    print(f"Prepared Python {lock['python']} in {target}")


if __name__ == "__main__":
    main()
