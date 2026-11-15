!define WINCMUX_CORE_SOURCE "${__FILEDIR__}\..\binaries\wincmux-core-x86_64-pc-windows-msvc.exe"
!macro WinCMuxPrepare
  InitPluginsDir
  File /oname=$PLUGINSDIR\wincmux-core-setup.exe "${WINCMUX_CORE_SOURCE}"
  ExecWait '"$PLUGINSDIR\wincmux-core-setup.exe" --prepare-update' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "실행 중인 터미널이 있거나 WinCMux를 안전하게 종료할 수 없습니다. 작업을 마친 뒤 다시 실행하세요."
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
!macro NSIS_HOOK_PREINSTALL
  !insertmacro WinCMuxPrepare
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WinCMuxPrepare
!macroend
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\wincmux" "" "URL:WinCMux notification"
  WriteRegStr HKCU "Software\Classes\wincmux" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\wincmux\shell\open\command" "" '$\"$INSTDIR\wincmux-tauri.exe$\" --open-notification $\"%1$\"'
  ExecWait '"$PLUGINSDIR\wincmux-core-setup.exe" --cancel-update'
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $1 HKCU "Software\Classes\wincmux\shell\open\command" ""
  ${If} $1 == '$\"$INSTDIR\wincmux-tauri.exe$\" --open-notification $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\wincmux"
  ${EndIf}
  ExecWait '"$PLUGINSDIR\wincmux-core-setup.exe" --cancel-update'
!macroend

; MUI abort callbacks release a preparation lease immediately when the user cancels.
!define MUI_CUSTOMFUNCTION_ABORT WinCMuxCancel
!define MUI_CUSTOMFUNCTION_UNABORT un.WinCMuxCancel
Function WinCMuxCancel
  IfFileExists "$PLUGINSDIR\wincmux-core-setup.exe" 0 +2
  ExecWait '"$PLUGINSDIR\wincmux-core-setup.exe" --cancel-update'
FunctionEnd
Function un.WinCMuxCancel
  IfFileExists "$PLUGINSDIR\wincmux-core-setup.exe" 0 +2
  ExecWait '"$PLUGINSDIR\wincmux-core-setup.exe" --cancel-update'
FunctionEnd
