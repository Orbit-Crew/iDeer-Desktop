import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { nsisInvocation } from '../resources/nsis/command.cjs'

// The real installer matrix (GUI tier picking) cannot run headless; this
// compiles the actual generated components.nsh with the bundled makensis and
// exercises the section bodies silently — the default flags are the silent
// /S contract (常用 tier installs the CAD viewer) and a deselected CAD
// section proves 未选不装. The pending component never writes anything.
it.skipIf(process.platform !== 'win32')('installer component sections install only what is selected and uninstall their own files', async () => {
  // Space-free scratch paths: NSIS uninstaller arguments (_=dir) must never
  // be quoted, so the whole test tree stays free of spaces.
  const scratch = mkdtempSync(join(tmpdir(), 'ideer-NSIS-components-'))
  const buildResources = join(scratch, 'build-resources')
  mkdirSync(join(buildResources, 'occt'), { recursive: true })
  writeFileSync(join(buildResources, 'occt/occt-import-js.js'), 'fixture-glue')
  writeFileSync(join(buildResources, 'occt/occt-import-js.wasm'), 'fixture-wasm')
  const run = (file: string, args: string[], options: object = {}) =>
    spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 30000, ...options })
  try {
    for (const deselectCad of [false, true]) {
      const name = deselectCad ? 'minimal' : 'typical'
      const source = join(scratch, `components-${name}.nsi`)
      const installer = join(scratch, `components-${name}.exe`)
      writeFileSync(source, `Unicode true
Name "iDeer components fixture ${name}"
OutFile "${installer}"
RequestExecutionLevel user
SilentInstall silent
!define APP_EXECUTABLE_FILENAME "ideer-desktop.exe"
!define BUILD_RESOURCES_DIR "${buildResources}"
!include "${resolve('resources/nsis/components.nsh')}"
Function .onInit
  !insertmacro customInit
!ifdef IDEER_TEST_DESELECT_CAD
  SectionSetFlags \${SEC_IDEER_CAD_VIEWER} 0
!endif
FunctionEnd
Section "install"
  SetOutPath "$INSTDIR"
  FileOpen $4 "$INSTDIR\\core-installed.txt" w
  FileWrite $4 "core"
  FileClose $4
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "un.install"
  !insertmacro customUnInstall
  Delete "$INSTDIR\\core-installed.txt"
  Delete "$INSTDIR\\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`)
      const compile = run(resolve('.cache/electron-builder/nsis/nsis-3.0.4.1/makensis.exe'),
        ['/V2', ...(deselectCad ? ['-DIDEER_TEST_DESELECT_CAD'] : []), source])
      expect({ name, code: compile.status, stderr: compile.stderr }).toEqual({ name, code: 0, stderr: '' })

      const target = join(scratch, `installed-${name}`)
      mkdirSync(target)
      const invocation = nsisInvocation(installer, target)
      const installed = run(invocation.file, invocation.args, invocation.options)
      expect({ name, code: installed.status, stderr: installed.stderr }).toEqual({ name, code: 0, stderr: '' })
      expect(existsSync(join(target, 'core-installed.txt')), `${name}: core missing`).toBe(true)
      const occtJs = existsSync(join(target, 'resources/occt/occt-import-js.js'))
      const occtWasm = existsSync(join(target, 'resources/occt/occt-import-js.wasm'))
      // Default flags = the silent /S contract: the CAD viewer rides along
      // (常用 tier). With the section deselected nothing may appear — the
      // pending CATIA/Abaqus and bundled Tecplot entries never write files.
      expect({ name, occtJs, occtWasm }).toEqual({ name, occtJs: !deselectCad, occtWasm: !deselectCad })
      if (!deselectCad) {
        expect(readFileSync(join(target, 'resources/occt/occt-import-js.js'), 'utf8')).toBe('fixture-glue')
        expect(readFileSync(join(target, 'resources/occt/occt-import-js.wasm'), 'utf8')).toBe('fixture-wasm')
      }

      // Each section's files disappear again on uninstall (customUnInstall
      // plus the fixture's own removal of the core marker). The NSIS
      // uninstaller re-launches its temp copy asynchronously, so wait for it
      // to finish the same way the install smoke polls for the exe to vanish.
      const uninstaller = join(target, 'uninstall.exe')
      const uninstall = run(uninstaller, ['/S', '_=' + target])
      expect({ name, code: uninstall.status, stderr: uninstall.stderr }).toEqual({ name, code: 0, stderr: '' })
      const deadline = Date.now() + 15000
      while (existsSync(uninstaller) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(existsSync(uninstaller), `${name}: uninstaller never finished`).toBe(false)
      expect(existsSync(join(target, 'resources/occt/occt-import-js.js')), `${name}: occt survived uninstall`).toBe(false)
      expect(existsSync(join(target, 'core-installed.txt')), `${name}: core survived uninstall`).toBe(false)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60000)
