"""Workspace selection and signed reconnect transactions at the public controller boundary."""
import asyncio

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from core import tray as tray_module
from core.settings import RuntimeSettings
from core.tray import TrayController


def test_desktop_reconnect_cannot_restore_a_directory_replaced_during_session_save(tmp_path, monkeypatch):
    import json
    import threading
    from websockets.asyncio.server import serve
    from core.file_service import WorkspaceSelection
    from core.protocol import MessageType, public_key_text, sign_envelope
    from core.settings import load_settings

    async def scenario():
        profile = tmp_path / 'profile'
        config = profile / 'settings.json'
        first, second = tmp_path / 'W1', tmp_path / 'W2'
        first.mkdir()
        second.mkdir()
        broker_key = Ed25519PrivateKey.generate()
        loaded, release_reader, selection_started, selected = (threading.Event() for _ in range(4))
        result = {}

        async def broker(socket):
            hello = json.loads(await socket.recv())
            await socket.send(json.dumps(sign_envelope(private_key=broker_key,
                message_type=MessageType.HELLO, device_id='D1', session_id=hello['session_id'],
                payload={'server_public_key': public_key_text(broker_key), 'protocol_version': '1'})))
            await socket.wait_closed()

        async with serve(broker, '127.0.0.1', 0) as server:
            settings = RuntimeSettings(server_url=f'http://127.0.0.1:{server.sockets[0].getsockname()[1]}',
                user_id='A', device_id='D1', session_token='isolated-token',
                server_public_key=public_key_text(broker_key), secret_backend='memory',
                config_path=str(config))
            settings.save(config)
            selection = WorkspaceSelection(config)
            selection.select(str(first), confirmed=True)
            controller = TrayController(settings=settings, private_key=Ed25519PrivateKey.generate(),
                desktop_mode=True, consent_store_path=profile / 'consent.db')

            def delayed_session_read(path):
                snapshot = load_settings(path)
                loaded.set()
                assert release_reader.wait(5)
                return snapshot

            def choose_second():
                selection_started.set()
                result.update(selection.select(str(second), confirmed=True))
                selected.set()

            monkeypatch.setattr(tray_module, 'load_settings', delayed_session_read)
            chooser = threading.Thread(target=choose_second)
            try:
                await asyncio.to_thread(controller.start)
                assert await asyncio.to_thread(loaded.wait, 5)
                chooser.start()
                assert await asyncio.to_thread(selection_started.wait, 5)
                # Give the competing public selection a chance to finish while
                # the connection callback holds its loaded snapshot. A correct
                # transaction blocks it until the callback commits.
                await asyncio.to_thread(selected.wait, 0.3)
                release_reader.set()
                assert await asyncio.to_thread(selected.wait, 5)
                await asyncio.to_thread(chooser.join, 5)
                assert selection.status()['logicalRoot'] == result['logicalRoot']
                assert load_settings(config).workspace['physical_root'] == str(second.resolve())
            finally:
                release_reader.set()
                await asyncio.to_thread(controller.stop)
                if chooser.ident is not None:
                    await asyncio.to_thread(chooser.join, 5)

    asyncio.run(scenario())

