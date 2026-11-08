; Issue 119: the installer customization entry electron-builder includes at
; the top of its generated script. The process guard (#107's basename-wide
; taskkill replacement) keeps its behavior unchanged; the selectable
; dependency tiers and engineering components are generated from the
; checked-in catalog (resources/components/catalog.json) by
; scripts/generate-component-nsis.cjs.
;
; electron-builder registers <repo>/resources on the NSIS include path
; (!addincludedir), and NSIS resolves subdirectory includes from it with
; backslash separators only.
!include "nsis\process-guard.nsh"
!include "nsis\components.nsh"
