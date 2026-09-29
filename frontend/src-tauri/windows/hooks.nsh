; Hooks of the NSIS installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Before the files are copied, remove the sidecar an earlier version left in the install folder, so that no
; stale file stays beside the new ones when the update skips the old uninstaller: the onedir folder of an
; earlier build (files the new one no longer has) and the onefile sidecar.exe of 0.2.0 and before (externalBin).
; The MSI removes the files of the version it replaces by itself.

!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\sidecar"
  Delete "$INSTDIR\sidecar.exe"
!macroend
