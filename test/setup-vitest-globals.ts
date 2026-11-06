// Shared vitest setup. Issue 110: the dock's panel registry pulls the xterm.js
// renderer into every test that imports the entry layer (App, DockWorkspace,
// panelRegistry, the terminal pane); @xterm's published builds are UMD and
// expect a browser-like `self` at module scope, which the plain node test
// environment lacks. jsdom already defines `self`, so this is a no-op there.
const globals = globalThis as unknown as { self?: unknown }
if (globals.self === undefined) globals.self = globalThis
