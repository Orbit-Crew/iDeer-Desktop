"""Small Local Runtime client surface for the M7 device protocol."""

from .artifacts import (
    ArtifactUploader,
    ArtifactUploadError,
    FileArtifactUploader,
    MemoryArtifactUploader,
    SingleUseUploadGrant,
)
from .capabilities import CapabilityAnnouncement, CapabilityRegistry
from .cli import main as runtime_cli
from .consent import ConsentExchange, ConsentRequest, ConsentStore, request_hash
from .file_service import FileTaskResult, LocalFileService
from .files import FileAccessError, LocalFileStore, RootConfig
from .policy import LocalPolicy, PolicyDecision, RiskLevel
from .python import LocalPythonService, PythonExecutor, PythonResult, PythonTaskStatus
from .receipts import LocalExecutionReceipt
from .secrets import (
    InMemorySecretStore,
    ResolvedSecrets,
    SecretBackendUnavailable,
    SecretNotFound,
    SecretRedactor,
    SecretResolver,
    SecretStore,
    SecretStoreError,
    WindowsCredentialStore,
    create_default_secret_store,
    is_secret_ref,
    secret_ref,
)
from .transport import LocalRuntimeClient, RePairRequired

__all__ = [
    "ArtifactUploadError",
    "ArtifactUploader",
    "CapabilityAnnouncement",
    "CapabilityRegistry",
    "ConsentExchange",
    "ConsentRequest",
    "ConsentStore",
    "FileAccessError",
    "FileArtifactUploader",
    "FileTaskResult",
    "InMemorySecretStore",
    "LocalExecutionReceipt",
    "LocalFileService",
    "LocalFileStore",
    "LocalPolicy",
    "LocalPythonService",
    "LocalRuntimeClient",
    "MemoryArtifactUploader",
    "PolicyDecision",
    "PythonExecutor",
    "PythonResult",
    "PythonTaskStatus",
    "RePairRequired",
    "ResolvedSecrets",
    "RiskLevel",
    "RootConfig",
    "SecretBackendUnavailable",
    "SecretNotFound",
    "SecretRedactor",
    "SecretResolver",
    "SecretStore",
    "SecretStoreError",
    "SingleUseUploadGrant",
    "WindowsCredentialStore",
    "create_default_secret_store",
    "is_secret_ref",
    "request_hash",
    "runtime_cli",
    "secret_ref",
]
