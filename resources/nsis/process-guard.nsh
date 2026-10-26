; Replace electron-builder's basename-wide taskkill policy. Check only the
; executable in this selected installation directory; never terminate a process.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  ideer_guard_probe:
    ; GENERIC_WRITE, no sharing, OPEN_EXISTING. This opens but writes no bytes.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0 ?e'
    Pop $1
    IntCmp $0 -1 ideer_guard_locked
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto ideer_guard_done
  ideer_guard_locked:
    IntCmp $1 2 ideer_guard_done
    IntCmp $1 3 ideer_guard_done
    IntOp $2 $2 + 1
    IntCmp $2 50 ideer_guard_abort 0 ideer_guard_abort
    Sleep 100
    Goto ideer_guard_probe
  ideer_guard_abort:
    DetailPrint "The selected installation is busy or cannot be safely opened. No process was stopped."
    IfSilent ideer_guard_quit
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close the app running from $INSTDIR and retry. No process has been stopped."
  ideer_guard_quit:
    SetErrorLevel 73
    Quit
  ideer_guard_done:
    Pop $2
    Pop $1
    Pop $0
!macroend
