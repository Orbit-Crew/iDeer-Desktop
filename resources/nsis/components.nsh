; GENERATED FILE — DO NOT EDIT.
; Produced by scripts/generate-component-nsis.cjs from resources/components/catalog.json.
; Regenerate with: npm run components:generate
!ifndef IDEER_COMPONENTS_NSH
!define IDEER_COMPONENTS_NSH

; Issue 119: the three dependency tiers are NSIS install types (1-based
; in declaration order). 最小 = 主程序 + 内置 Python Runtime（Runtime 是核心，
; 应用离开它无法工作，故不作为可选组件）；常用 = 再加常用工程组件；自定义 =
; 从常用配置开始自行勾选。向导不联网安装任何额外内容。
InstType "最小安装"
InstType "常用安装"
InstType "自定义"

; The components page rides between the directory page and the installing
; page through electron-builder's customPageAfterChangeDir hook.
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_COMPONENTS
!macroend

; Sections live in the installer build only — the uninstaller build pass
; would otherwise embed every artifact a second time.
!ifndef BUILD_UNINSTALLER

Section "CAD 查看器" SEC_IDEER_CAD_VIEWER
  SectionIn 2 3
  SetOutPath "$INSTDIR\resources\occt"
  File "${BUILD_RESOURCES_DIR}\occt\occt-import-js.js"
  File "${BUILD_RESOURCES_DIR}\occt\occt-import-js.wasm"
SectionEnd

Section "Tecplot 面板（随主程序内置，无需单独安装）" SEC_IDEER_TECPLOT_PANEL
  SectionIn RO
  ; Intentional no-op: this component is part of the app bundle; the
  ; entry exists so the wizard states that honestly.
SectionEnd

Section /o "CATIA/Abaqus 配套组件（待提供：需待 #87 落地后随离线组件包补装）" SEC_IDEER_CATIA_ABAQUS
  ; Intentional no-op: pending upstream work — explicitly not installable.
SectionEnd

; The core section (electron-builder's "install" section) is the next one
; after the component sections above. Guard the layout: if that assumption
; ever breaks, abort loudly instead of protecting the wrong section.
!define IDEER_CORE_SECTION_INDEX 3

!macro customInit
  SectionGetText ${IDEER_CORE_SECTION_INDEX} $0
  StrCmp $0 "install" ideer_components_core_ok
  DetailPrint "iDeer: unexpected installer section layout (section 3 is $0)"
  Abort
  ideer_components_core_ok:
  SectionSetText ${IDEER_CORE_SECTION_INDEX} "主程序与 Python Runtime（必装）"
  SectionSetFlags ${IDEER_CORE_SECTION_INDEX} 17
  ; catia-abaqus stays visible but locked read-only and unselected:
  ; pending components are never silently installable.
  SectionSetFlags ${SEC_IDEER_CATIA_ABAQUS} 16
!macroend

!endif ; !BUILD_UNINSTALLER

; Each available component section uninstalls its own files (the stock
; uninstaller's RMDir /r $INSTDIR also removes them; these lines state
; the ownership explicitly).
!macro customUnInstall
  Delete "$INSTDIR\resources\occt\occt-import-js.js"
  Delete "$INSTDIR\resources\occt\occt-import-js.wasm"
  RMDir "$INSTDIR\resources\occt"
!macroend

!endif ; IDEER_COMPONENTS_NSH
