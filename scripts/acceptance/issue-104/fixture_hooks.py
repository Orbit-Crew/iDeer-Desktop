"""Loss, disconnect and duplicate delivery on the real signed socket."""
import asyncio
import importlib.util
import json
from pathlib import Path

base = Path(__file__).resolve().parents[1] / 'issue-102' / 'fixture_hooks.py'
spec = importlib.util.spec_from_file_location('issue102_faults', base)
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
_loop = None
_frames = {}


def install(broker, directory):
    previous.install(broker, directory)
    attach = broker.attach

    async def attach_with_duplicates(connection):
        global _loop
        _loop = asyncio.get_running_loop()
        original_send = connection.websocket.send_text
        await attach(connection)
        send = connection.websocket.send_text

        async def capture(text):
            frame = json.loads(text)
            if frame.get('type') == 'task':
                _frames[frame['task_id']] = (original_send, text)
            await send(text)
        connection.websocket.send_text = capture
    broker.attach = attach_with_duplicates


def process_control(broker, directory):
    previous.process_control(broker, directory)
    command = directory / 'duplicate-request.json'
    if not command.exists() or _loop is None:
        return
    request = json.loads(command.read_text())
    command.unlink()

    async def duplicate():
        send, text = _frames[request['taskId']]
        await send(text)
        previous.event(directory, 'task-duplicated', taskId=request['taskId'])
        previous.write_json(directory, 'duplicate-applied.json', request)
    asyncio.run_coroutine_threadsafe(duplicate(), _loop)
