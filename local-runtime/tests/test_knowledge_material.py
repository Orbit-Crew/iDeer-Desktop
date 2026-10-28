"""Frozen-document material for server-orchestrated graph generation (#116).

The task payload carries the frozen manifest identity and exactly one
document: the device refuses bulk requests outright, re-validates the
document against its frozen digest at read time, and returns the document
text only for an exact content-addressed match. Missing, drifted, oversized,
and non-text documents are structured missing reasons — never substituted
content. Reading is a LEVEL_1 capability: every material request waits for
the device user's local confirmation.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from contextlib import asynccontextmanager

import pytest

from core.file_service import WorkspaceFileService, WorkspaceFileStore, WorkspaceSelection
from core.files import RootConfig
from core.knowledge_import import KnowledgeImportRegistry
from core.knowledge_material import KnowledgeMaterialError, material_frozen_document, parse_material_payload
from core.policy import LocalPolicy
from core.receipt_ledger import profile_binding
from core.settings import RuntimeSettings

KB = '33333333-3333-4333-8333-333333333333'
REVISION = '55555555-5555-4555-8555-555555555555'
GUIDE = '甲零件属于乙组件。乙组件由甲零件与螺栓构成。\n'
NOTES = 'release notes\n'
MANIFEST = hashlib.sha256(json.dumps(sorted(['guide.txt', 'notes.txt'])).encode()).hexdigest()


def _document(name: str, content: str) -> dict:
    content_hash = hashlib.sha256(content.encode()).hexdigest()
    return {"document_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"local-import:{name}:{content_hash}")),
            "filename": name,
            "content_hash": content_hash}


def _payload(*, documents=None, manifest_hash=MANIFEST, revision_id=REVISION) -> dict:
    return {'revision_id': revision_id, 'manifest_hash': manifest_hash,
            'documents': documents if documents is not None else [_document('guide.txt', GUIDE)]}


# --- payload validation -------------------------------------------------------


def test_payload_validation_requires_exactly_one_document() -> None:
    parsed = parse_material_payload(_payload())
    assert parsed['revision_id'] == REVISION
    assert len(parsed['documents']) == 1

    for broken, code in [
        ({**_payload(), 'documents': []}, 'INVALID_MANIFEST'),
        ({**_payload(), 'documents': [_document('guide.txt', GUIDE), _document('notes.txt', NOTES)]}, 'BULK_REQUEST_REFUSED'),
        ({**_payload(), 'revision_id': 'not-a-uuid'}, 'INVALID_MANIFEST'),
        ({**_payload(), 'manifest_hash': 'zz'}, 'INVALID_MANIFEST'),
        ({**_payload(), 'documents': [{'document_id': _document('guide.txt', GUIDE)['document_id'], 'filename': '../escape', 'content_hash': 'a' * 64}]}, 'INVALID_MANIFEST'),
        ({**_payload(), 'documents': [{'document_id': 'x', 'filename': 'guide.txt', 'content_hash': 'a' * 64}]}, 'INVALID_MANIFEST'),
        (['not', 'a', 'dict'], 'INVALID_MANIFEST'),
        ({'revision_id': REVISION, 'manifest_hash': MANIFEST}, 'INVALID_MANIFEST'),
    ]:
        with pytest.raises(KnowledgeMaterialError) as error:
            parse_material_payload(broken)
        assert str(error.value) == code


# --- content-addressed revalidation -------------------------------------------


def _store(work_root):
    return WorkspaceFileStore([RootConfig('/workspace', work_root, resolve_root=False)])


def test_frozen_match_returns_verified_text(tmp_path) -> None:
    (tmp_path / 'docs').mkdir()
    (tmp_path / 'docs' / 'guide.txt').write_text(GUIDE, encoding='utf-8')
    result = material_frozen_document(_payload(), files=_store(tmp_path), logical_root='/workspace')

    assert result['document_id'] == _document('guide.txt', GUIDE)['document_id']
    assert result['filename'] == 'guide.txt'
    assert result['content_hash'] == hashlib.sha256(GUIDE.encode()).hexdigest()
    assert result['text'] == GUIDE
    # Physical paths never leave the device.
    assert str(tmp_path) not in json.dumps(result)


def test_drifted_file_reports_content_drift(tmp_path) -> None:
    (tmp_path / 'guide.txt').write_text('甲零件属于乙组件。已被修改。\n', encoding='utf-8')
    result = material_frozen_document(_payload(), files=_store(tmp_path), logical_root='/workspace')
    assert result == {'document_id': _document('guide.txt', GUIDE)['document_id'], 'missing': True, 'reason': 'content_drift'}


def test_removed_file_reports_document_unavailable(tmp_path) -> None:
    result = material_frozen_document(_payload(), files=_store(tmp_path), logical_root='/workspace')
    assert result == {'document_id': _document('guide.txt', GUIDE)['document_id'], 'missing': True, 'reason': 'document_unavailable'}


def test_binary_frozen_bytes_report_not_text(tmp_path) -> None:
    raw = b'\x00\x01\x02binary\x00'
    document = {'document_id': _document('guide.txt', GUIDE)['document_id'], 'filename': 'guide.txt',
                'content_hash': hashlib.sha256(raw).hexdigest()}
    (tmp_path / 'guide.txt').write_bytes(raw)
    result = material_frozen_document(_payload(documents=[document]), files=_store(tmp_path), logical_root='/workspace')
    assert result == {'document_id': document['document_id'], 'missing': True, 'reason': 'not_text'}


def test_oversized_frozen_bytes_refuse_instead_of_truncating(tmp_path) -> None:
    from core.knowledge_material import MAX_MATERIAL_BYTES
    raw = (b'a' * 1024) * (MAX_MATERIAL_BYTES // 1024 + 1)
    document = {'document_id': _document('guide.txt', GUIDE)['document_id'], 'filename': 'guide.txt',
                'content_hash': hashlib.sha256(raw).hexdigest()}
    (tmp_path / 'guide.txt').write_bytes(raw)
    result = material_frozen_document(_payload(documents=[document]), files=_store(tmp_path), logical_root='/workspace')
    assert result == {'document_id': document['document_id'], 'missing': True, 'reason': 'document_too_large'}


def test_duplicate_names_still_find_the_frozen_bytes(tmp_path) -> None:
    (tmp_path / 'guide.txt').write_text('drifted\n', encoding='utf-8')
    (tmp_path / 'archive').mkdir()
    (tmp_path / 'archive' / 'guide.txt').write_text(GUIDE, encoding='utf-8')
    result = material_frozen_document(_payload(), files=_store(tmp_path), logical_root='/workspace')
    assert result['text'] == GUIDE


# --- registry-bound workspace service -----------------------------------------


def _settings(config) -> RuntimeSettings:
    settings = RuntimeSettings(server_url='https://test.invalid', user_id='A', device_id='D1')
    settings.device_public_key = 'device-public-key'
    settings.server_public_key = 'broker-public-key'
    settings.save(config)
    return settings


def _service(config, work) -> tuple[WorkspaceFileService, str, dict]:
    settings = _settings(config)
    selection = WorkspaceSelection(config)
    root = selection.select(str(work), confirmed=True)['logicalRoot']
    binding = profile_binding(settings)
    assert binding is not None
    return WorkspaceFileService(selection), root, binding


def _register(config, binding, documents) -> None:
    registry = KnowledgeImportRegistry(config.with_name('knowledge-imports.db'))
    assert registry.record(binding, dict(kb_id=KB, status='registered', revision_id=REVISION,
        revision_no=1, manifest_hash=MANIFEST, document_count=len(documents), documents=documents))


def test_service_requires_consent_then_returns_verified_text(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_text(GUIDE, encoding='utf-8')
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding, [dict(filename='guide.txt', sha256=hashlib.sha256(GUIDE.encode()).hexdigest(),
        bytes=len(GUIDE), mime='text/plain')])

    task = service.execute('local.knowledge.material', {'arguments': _payload()})
    # Material leaves the device only after local confirmation: the first
    # answer is a consent request, not content.
    assert task.decision.value == 'consent_required'
    assert task.value is None

    task = service.execute('local.knowledge.material', {'arguments': _payload()}, consent=True)
    assert task.decision.value == 'allow'
    assert task.value['text'] == GUIDE


def test_service_refuses_revisions_this_identity_never_registered(tmp_path) -> None:
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'guide.txt').write_text(GUIDE, encoding='utf-8')
    config = tmp_path / 'profile' / 'settings.json'
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    with pytest.raises(KnowledgeMaterialError) as error:
        service.execute('local.knowledge.material', {'arguments': _payload()}, consent=True)
    assert str(error.value) == 'KNOWLEDGE_MATERIAL_REVISION_UNKNOWN'


def test_policy_treats_material_as_consent_level(tmp_path) -> None:
    policy = LocalPolicy()
    assert policy.risk_level('local.knowledge.material', {}).value == 'level_1'
    assert policy.authorize('local.knowledge.material', {}, consent=False).value == 'consent_required'
    assert policy.authorize('local.knowledge.material', {}, consent=True).value == 'allow'
    denied = LocalPolicy(denied_capabilities=frozenset({'local.knowledge.material'}))
    assert denied.authorize('local.knowledge.material', {}, consent=True).value == 'deny'


# --- signed transport contract -------------------------------------------------


@asynccontextmanager
async def connected_client(**options):
    import asyncio
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from websockets.asyncio.server import serve
    from core.protocol import public_key_text
    from core.transport import LocalRuntimeClient
    from server_protocol import MessageType as ServerMessageType, sign_envelope as server_sign

    broker_key = Ed25519PrivateKey.generate()
    ready = asyncio.Queue()
    done = asyncio.Event()

    async def broker(socket):
        await ready.put(socket)
        await done.wait()

    async with serve(broker, "127.0.0.1", 0) as server:
        client = LocalRuntimeClient(
            server_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}",
            device_id="desktop-test", session_token="isolated-test-token",
            private_key=Ed25519PrivateKey.generate(), server_public_key=public_key_text(broker_key),
            **options,
        )
        running = asyncio.create_task(client.run())
        socket = await asyncio.wait_for(ready.get(), 5)
        hello = json.loads(await socket.recv())

        def frame(payload, task_id="task-116", **kwargs):
            return server_sign(private_key=broker_key, message_type=ServerMessageType.TASK,
                device_id="desktop-test", session_id=hello["session_id"], task_id=task_id,
                payload=payload, **kwargs).model_dump(mode="json", by_alias=True)

        await socket.send(json.dumps(server_sign(private_key=broker_key,
            message_type=ServerMessageType.HELLO, device_id="desktop-test",
            session_id=hello["session_id"], payload={"server_public_key": public_key_text(broker_key),
            "protocol_version": "1"}).model_dump(mode="json", by_alias=True)))
        try:
            yield socket, frame
        finally:
            done.set()
            await client.shutdown()
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


async def _material_outcome(socket):
    import asyncio
    while True:
        value = json.loads(await asyncio.wait_for(socket.recv(), 5))
        if value["type"] in {"error", "task_result", "consent_required"}:
            return value


def test_signed_material_task_asks_for_local_consent_before_any_text(tmp_path) -> None:
    """No confirmation, no document text: the wire answer is a consent request."""
    import asyncio

    work = tmp_path / "work"
    work.mkdir()
    (work / "guide.txt").write_text(GUIDE, encoding="utf-8")
    config = tmp_path / "profile" / "settings.json"
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding, [dict(filename="guide.txt", sha256=hashlib.sha256(GUIDE.encode()).hexdigest(),
        bytes=len(GUIDE), mime="text/plain")])

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities) as (socket, frame):
            await socket.send(json.dumps(frame({"operation": "local.knowledge.material", "run_id": "run-116",
                "tool_call_id": "call-116", "arguments": _payload()}, task_id="task-116")))
            response = await _material_outcome(socket)
            assert response["type"] == "consent_required"
            assert "text" not in json.dumps(response)
            assert str(work) not in json.dumps(response)

    asyncio.run(scenario())


def test_signed_material_task_returns_verified_text_after_consent(tmp_path) -> None:
    import asyncio

    work = tmp_path / "work"
    work.mkdir()
    (work / "guide.txt").write_text(GUIDE, encoding="utf-8")
    config = tmp_path / "profile" / "settings.json"
    config.parent.mkdir(parents=True)
    service, root, binding = _service(config, work)
    _register(config, binding, [dict(filename="guide.txt", sha256=hashlib.sha256(GUIDE.encode()).hexdigest(),
        bytes=len(GUIDE), mime="text/plain")])

    async def approve(pending):
        return {"approved": True, "always": False}

    async def scenario():
        async with connected_client(file_service=service, capabilities=service.capabilities,
                                    consent_prompt=approve) as (socket, frame):
            await socket.send(json.dumps(frame({"operation": "local.knowledge.material", "run_id": "run-116",
                "tool_call_id": "call-116", "arguments": _payload()}, task_id="task-116-consent")))
            response = await _material_outcome(socket)
            assert response["type"] == "task_result"
            result = response["payload"]["result"]
            assert result["text"] == GUIDE
            receipt = response["payload"]["receipt"]
            assert receipt["capability"] == "local.knowledge.material"
            assert receipt["status"] == "completed"
            assert str(work) not in json.dumps(response)

    asyncio.run(scenario())
