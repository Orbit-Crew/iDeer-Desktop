import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { nsisInvocation } from '../resources/nsis/command.cjs'

it.skipIf(process.platform !== 'win32')('NSIS checks only the target executable without killing any same-name process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ideer NSIS guard ')), target = join(root, 'target'), outside = join(root, 'outside')
  mkdirSync(target); mkdirSync(outside)
  const targetExe = join(target, 'ideer-desktop.exe'), outsideExe = join(outside, 'ideer-desktop.exe')
  copyFileSync(process.execPath, targetExe); copyFileSync(process.execPath, outsideExe)
  const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  const original = hash(targetExe), guard = join(root, 'guard.exe'), source = join(root, 'guard.nsi')
  const children: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = []
  const start = async (executable: string): Promise<ReturnType<typeof spawn>> => {
    const child = spawn(executable, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    children.push({ child, closed })
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    return child
  }
  try {
    writeFileSync(source, `Unicode true\nName "iDeer guard fixture"\nOutFile "${guard}"\nRequestExecutionLevel user\nInstallDir "${target}"\nSilentInstall silent\n!define APP_EXECUTABLE_FILENAME "ideer-desktop.exe"\n!include "${resolve('resources/nsis/process-guard.nsh')}"\nSection\n!insertmacro customCheckAppRunning\nFileOpen $3 "$INSTDIR\\guard-passed.txt" w\nFileWrite $3 "TARGET WAS SAFE"\nFileClose $3\nSetErrorLevel 0\nSectionEnd\n`)
    const compiled = spawnSync(resolve('.cache/electron-builder/nsis/nsis-3.0.4.1/makensis.exe'), ['/V2', source], { windowsHide: true, encoding: 'utf8' })
    expect({ code: compiled.status, stderr: compiled.stderr }).toEqual({ code: 0, stderr: '' })
    const unrelated = await start(outsideExe)
    const invoke = (directory: string) => {
      const invocation = nsisInvocation(guard, directory)
      return spawnSync(invocation.file, invocation.args, { ...invocation.options, encoding: 'utf8', timeout: 10000 }).status
    }
    expect(invoke(target)).toBe(0)
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    rmSync(join(target, 'guard-passed.txt'))
    const running = await start(targetExe)
    expect(invoke(target)).toBe(73)
    expect(existsSync(join(target, 'guard-passed.txt'))).toBe(false)
    expect(() => process.kill(running.pid!, 0)).not.toThrow()
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
    expect(hash(targetExe)).toBe(original); expect(hash(outsideExe)).toBe(original)
    running.kill(); await children.find(item => item.child === running)!.closed
    expect(invoke(target)).toBe(0)
    const empty = join(root, 'fresh-install'); mkdirSync(empty)
    expect(invoke(empty)).toBe(0)
    expect(existsSync(join(empty, 'guard-passed.txt'))).toBe(true)
  } finally {
    for (const { child, closed } of children) { if (child.exitCode === null) child.kill(); await closed }
    rmSync(root, { recursive: true, force: true })
  }
}, 25000)
