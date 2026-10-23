"""Transport fault controls for an acceptance-owned Server process only.

Every real signed task is delivered by the unmodified broker. These wrappers
can lose completion traffic or disconnect the socket, as a network can.
They never synthesize a successful execution or an approval.
"""
import asyncio
from datetime import datetime, timezone
import json
import threading
import traceback

_loop = None
_write_lock = threading.Lock()


def record_http_exception(directory, method, route, error):
    """Keep only exception types and frames, never messages, locals or headers."""
    def summarize(value):
        result = {'type': type(value).__name__, 'frames': [
            {'file': frame.filename.replace('\\\\', '/').split('/')[-1], 'line': frame.lineno, 'function': frame.name}
            for frame in traceback.extract_tb(value.__traceback__)]}
        children = getattr(value, 'exceptions', ())
        if children:
            result['children'] = [summarize(child) for child in children]
        elif value.__cause__ is not None:
            result['cause'] = summarize(value.__cause__)
        return result
    event(directory, 'http-exception', method=method, route=route, exception=summarize(error))


def write_json(directory, name, value):
    temporary = directory / (name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temporary.replace(directory / name)


def event(directory, name, **value):
    with _write_lock:
        with (directory / 'wire-events.jsonl').open('a', encoding='utf-8') as output:
            output.write(json.dumps({'event': name, 'at': datetime.now(timezone.utc).isoformat(), **value}) + '\n')


def install(broker, directory):
    attach = broker.attach
    receive = broker.receive

    async def attach_with_events(connection):
        global _loop
        _loop = asyncio.get_running_loop()
        send = connection.websocket.send_text

        async def send_with_events(text):
            frame = json.loads(text)
            kind = str(frame.get('type'))
            if kind == 'task':
                payload = frame['payload']
                event(directory, 'task-dispatched', taskId=frame['task_id'], runId=payload.get('run_id'),
                      toolCallId=payload.get('tool_call_id'), requestHash=frame.get('payload_hash'),
                      operation=payload.get('operation'))
            if kind == 'receipt_ack' and (directory / 'drop-acks').exists():
                event(directory, 'ack-dropped', taskId=frame.get('task_id'), **frame['payload'])
                return
            await send(text)
            if kind == 'receipt_ack':
                event(directory, 'ack-sent', taskId=frame.get('task_id'), **frame['payload'])

        connection.websocket.send_text = send_with_events
        event(directory, 'device-attached', deviceId=connection.device_id)
        return await attach(connection)

    async def receive_with_fault(connection, envelope):
        kind = str(envelope.type)
        task_id = envelope.task_id
        if kind == 'task_result':
            receipt = envelope.payload.get('receipt') or {}
            event(directory, 'task-result-received', taskId=task_id,
                  status=receipt.get('status'), errorCode=envelope.payload.get('error_code'),
                  receipt=receipt, result=envelope.payload.get('result'))
            if (directory / 'hold-results').exists():
                event(directory, 'task-result-dropped', taskId=task_id)
                write_json(directory, 'result-held.json', {'taskId': task_id, 'receipt': receipt})
                if (directory / 'disconnect-after-result').exists():
                    await connection.websocket.close(code=1012, reason='T102 isolated network loss after effect')
                return None
        if kind == 'receipt_upload':
            if (directory / 'hold-uploads').exists():
                event(directory, 'upload-dropped', taskId=task_id)
                return None
            event(directory, 'upload-received', taskId=task_id,
                  receiptHash=envelope.payload.get('receipt_hash'))
        return await receive(connection, envelope)

    broker.attach = attach_with_events
    broker.receive = receive_with_fault


def process_control(broker, directory):
    path = directory / 'disconnect-request.json'
    if not path.exists() or _loop is None:
        return
    request = json.loads(path.read_text(encoding='utf-8'))
    path.unlink()

    async def close():
        connections = list(broker.connections.values())
        for connection in connections:
            await connection.websocket.close(code=1012, reason='T102 isolated network loss before effect')
        event(directory, 'disconnect-request-applied', requestId=request['id'], connectionCount=len(connections))
        write_json(directory, 'disconnect-applied.json', {'id': request['id'], 'closedConnections': len(connections)})

    asyncio.run_coroutine_threadsafe(close(), _loop)
