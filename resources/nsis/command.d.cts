import type { SpawnOptionsWithoutStdio } from 'node:child_process'
export function nsisInvocation(installer: string, programRoot: string): {
  file: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}
