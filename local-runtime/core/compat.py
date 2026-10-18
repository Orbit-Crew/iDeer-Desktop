"""Small standard-library compatibility shims for the Windows 7 runtime."""

from __future__ import annotations

import os
from datetime import timezone
from enum import Enum

try:
    from datetime import UTC as UTC
except ImportError:  # pragma: no cover - Python 3.10 and older
    UTC = timezone.utc

try:
    from enum import StrEnum as StrEnum
except ImportError:  # pragma: no cover - exercised on Python 3.10 and older

    class StrEnum(str, Enum):
        """Backport of :class:`enum.StrEnum` used by Python 3.8/3.9."""

        def __str__(self) -> str:
            return self.value


try:
    from os.path import isjunction as is_junction
except ImportError:  # pragma: no cover - exercised on Python 3.11 and older
    # Junctions are mount-point reparse points; os.path gained a dedicated
    # check only in 3.12, so older interpreters read the lstat reparse tag.
    _IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003

    def is_junction(path: str | os.PathLike[str]) -> bool:
        try:
            status = os.lstat(path)
        except OSError:
            return False
        return getattr(status, "st_reparse_tag", 0) == _IO_REPARSE_TAG_MOUNT_POINT
