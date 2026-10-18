"""Acceptance-only outbound policy: the Runtime may reach the unified entry only."""
import asyncio
import socket
import threading

_Socket = socket.socket
_socketpair = socket.socketpair
_internal = threading.local()


class EntryOnlySocket(_Socket):
    def _check(self, address):
        if (self.family in {socket.AF_INET, socket.AF_INET6}
                and not getattr(_internal, 'socketpair', False)
                and (address[0] not in {'127.0.0.1', '::1'} or address[1] != 21980)):
            raise PermissionError('T98_DIRECT_GATEWAY_BLOCKED')

    def connect(self, address):
        self._check(address)
        return super().connect(address)

    def connect_ex(self, address):
        self._check(address)
        return super().connect_ex(address)


socket.socket = EntryOnlySocket


def socketpair(*args, **kwargs):
    # Windows implements the event loop's private wakeup pair with loopback
    # TCP. Allow only the stdlib socketpair constructor to create that pair.
    _internal.socketpair = True
    try:
        return _socketpair(*args, **kwargs)
    finally:
        _internal.socketpair = False


socket.socketpair = socketpair
# Selector's nonblocking connect uses the same guarded socket interface.
# This changes only the test transport policy, never the shipped source.
asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
for forbidden in [('127.0.0.1', 21981), ('192.0.2.1', 21980)]:
    try:
        with socket.socket() as probe:
            probe.connect(forbidden)
    except PermissionError as error:
        assert str(error) == 'T98_DIRECT_GATEWAY_BLOCKED'
    else:
        raise AssertionError('The test policy must allow only the loopback unified entry')

from core.desktop import main

raise SystemExit(main())
