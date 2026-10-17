# Local Runtime ownership

This is the Desktop-owned copy of Orbit-Crew/iDeer/local-runtime at
ccb251e07e5f5934b851e4c3df00224718f28123, with all original tests retained.

Install independently with `pip install .`, or `pip install '.[test]'` for the
regression lane. Run `python -m pytest tests -q`. Production has no Server imports.
Windows packaging uses the isolated interpreter and wheels in distribution.lock.json.
The main process owns core.desktop through a private stdio status/shutdown pipe.
Tasks arrive only through the existing outbound signed WebSocket protocol.

The original Server copy remains for cutover comparison; deletion belongs to
follow-up cutover work. See [migration and test mapping](../docs/runtime-migration.md)
and [issue #97 acceptance](../docs/acceptance/issue-97/report.md).
