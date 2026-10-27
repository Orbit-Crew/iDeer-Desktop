"""Do not report a completed write as an idle but unknown drain snapshot."""
import base64
import json
import threading
from types import SimpleNamespace

import pytest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from core import desktop
from core.file_service import WorkspaceSelection
from core.protocol import public_key_text
from core.receipt_ledger import profile_binding
from core.settings import RuntimeSettings


@pytest.mark.parametrize('transition', ['complete', 'start', 'unknown'])
def test_task_transition_during_desktop_status(tmp_path, monkeypatch, transition):
    config = tmp_path / 'profile' / 'settings.json'
    key = Ed25519PrivateKey.generate()
    settings = RuntimeSettings(server_url='http://127.0.0.1:108', user_id='account-108', device_id='device-108',
        session_token_ref='fixture-session', device_key_ref='fixture-key',
        device_public_key=public_key_text(key), server_public_key=public_key_text(key))
    settings.save(config)
    scope = WorkspaceSelection(config).scope()
    owner = profile_binding(settings)
    task = {'task_id': 'write-108', 'run_id': 'run-108', 'capability': 'local.files.write'}
    status_emitted = threading.Event()
    frames = []

    class Input:
        first = True

        def __iter__(self):
            return self

        def __next__(self):
            if self.first:
                self.first = False
                return json.dumps({'type': 'install-drain', 'id': 'drain-108', 'action': 'begin', 'scope': scope}) + '\n'
            if not status_emitted.wait(5):
                raise RuntimeError('desktop status was not emitted')
            raise StopIteration

    class Output:
        pending = ''

        def write(self, value):
            self.pending += value
            while '\n' in self.pending:
                line, self.pending = self.pending.split('\n', 1)
                if line:
                    frame = json.loads(line)
                    frames.append(frame)
                    if 'activeTasks' in frame:
                        status_emitted.set()
            return len(value)

        def flush(self):
            pass

    class Client:
        connected = True
        active = 1 if transition == 'complete' else 0
        file_service = SimpleNamespace()

        def begin_install_drain(self):
            pass

        def active_task_count(self):
            return self.active

    client = Client()

    class Controller:
        settings = SimpleNamespace(session_token='synthetic')

        def __init__(self):
            self.client = client

        def start(self):
            if transition != 'start':
                client.receipt_ledger.admit(owner, task)

        def status(self):
            # Simulate the actual worker finishing while the status thread
            # reads controller state after its earlier SQLite observation.
            if transition == 'complete' and client.active:
                client.receipt_ledger.complete(owner, {**task, 'status': 'completed', 'consent_decision': 'approved'})
                client.active = 0
            elif transition == 'start' and not client.active:
                client.receipt_ledger.admit(owner, task)
                client.active = 1
            return SimpleNamespace(connection='connected')

        def stop(self):
            pass

    secure = SimpleNamespace(get=lambda reference: base64.b64encode(
        key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())).decode())
    login = SimpleNamespace(secure=secure, restore=lambda: None,
        status=lambda: {'state': 'authenticated'}, server_origin=lambda: 'http://127.0.0.1:108')
    gate = SimpleNamespace(bind=lambda: None, snapshot=lambda: {})
    monkeypatch.setattr(desktop, 'own_process_tree', lambda: None)
    monkeypatch.setattr(desktop, 'create_default_secret_store', lambda: secure)
    monkeypatch.setattr(desktop, 'BrowserLogin', lambda *args: login)
    monkeypatch.setattr(desktop, 'CompatibilityGate', lambda *args, **kwargs: gate)
    monkeypatch.setattr(desktop, 'load_controller', lambda *args, **kwargs: Controller())
    monkeypatch.setattr(desktop.sys, 'argv', ['desktop', '--config', str(config)])
    monkeypatch.setattr(desktop.sys, 'stdin', Input())
    monkeypatch.setattr(desktop.sys, 'stdout', Output())
    assert desktop.main() == 0
    status, = [frame for frame in frames if 'activeTasks' in frame]
    assert status['installDrain'] is True
    if transition == 'complete':
        assert client.receipt_ledger.unknown_write_effects(None) == 0
        assert status['activeTasks'] > 0 or status['unknownWriteEffects'] == 0, \
            'a completed in-flight write must not be reported as idle with stale unknown effects'
    elif transition == 'start':
        assert status['activeTasks'] > 0, 'a task starting during observation must still prevent readiness'
    else:
        assert status['activeTasks'] == 0 and status['unknownWriteEffects'] == 1, \
            'a genuinely unknown write must remain blocked'
