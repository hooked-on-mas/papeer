; Hooks of the NSIS installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Before the files are copied, remove the sidecar an earlier version left in the install folder, so that no
; stale file stays beside the new ones when the update skips the old uninstaller: the onedir folder of an
; earlier build (files the new one no longer has) and the onefile sidecar.exe of 0.2.0 and before (externalBin).
; The MSI removes the files of the version it replaces by itself.
;
; Tauri's template runs this hook first in Section Install, before it checks that the app is closed
; (CheckIfAppIsRunning, which the user may cancel). While Papeer, its sidecar or the command line client
; (papeer-cli.exe, which a terminal or a script may be running; it also starts a headless sidecar) runs, the
; folder is left alone: deleting only the files not in use would leave an installed Papeer that cannot start
; if the user then cancels. The template's check asks to close the app next, and the new files are copied
; over the old. The user's PATH is not edited here (a long PATH could be cut): `papeer-cli setup-path` does it.

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
  ${If} $R0 != 0
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::FindProcessCurrentUser "papeer-sidecar.exe"
    !else
      nsis_tauri_utils::FindProcess "papeer-sidecar.exe"
    !endif
    Pop $R0
    ; 0: found, running.
    ${If} $R0 != 0
      !if "${INSTALLMODE}" == "currentUser"
        nsis_tauri_utils::FindProcessCurrentUser "papeer-cli.exe"
      !else
        nsis_tauri_utils::FindProcess "papeer-cli.exe"
      !endif
      Pop $R0
      ${If} $R0 != 0
        RMDir /r "$INSTDIR\sidecar"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R0
  Delete "$INSTDIR\sidecar.exe"
!macroend
