# Local Runtime ownership

This directory reserves the Desktop-owned Python Local Runtime boundary.
Issue #96 does not migrate or start it. There is no executable placeholder,
HTTP listener, subprocess launcher or alternate tool path.

The existing iDeer Runtime and its tests remain in their original repository until
the dedicated migration and cross-repository cutover are accepted. The migration
must preserve policy, consent, task verification, managed MCP, receipts and the
existing integration coverage. Only after cutover may the original implementation
be removed. Desktop must never drive a model or execute tools while Runtime is
unavailable.
