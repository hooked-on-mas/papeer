# Workspace-bound Windows trial preparation

This trial is for the local P1 startup, note edit, undo, save, and restart checks. It is not a redistributable build. Its executable has a trial-only entry point that validates a pre-provisioned workspace marker and paths, fixes Native library/device/temp settings, strips inherited app and WebView overrides and only then enters the unchanged shared Tauri library. Normal shortcuts, the NSIS finish action and direct GUI exe launch therefore go through the same guard. Directly launching the bundled sidecar or CLI bypasses this entry point and is outside the trial guarantee; AI/provider/CLI operations are also outside the local-note trial scope.

Preparation uses the B1 proof to verify the current backend source bundle, frontend source, and the complete smoke-tested sidecar. It creates a small Cargo overlay and fresh trial runtime under `output/`, never deletes or reuses an existing destination, references the normal Rust library and built frontend/sidecar, and retains normal bundle resources. Run from the repository root:

```
.\.venv\Scripts\python.exe tools/trial/prepare.py
```

The resulting `output/shared-trial-overlay/manifest.json` gives the check and future build commands and input hashes. `build.py check` validates these inputs without building; `build.py build` uses the next available write-once `build-rN` checkpoint, or accepts an explicit new `--stage build-rN`. Preparation itself does not build, install or launch. Cargo check is allowed offline; NSIS build, installation and actual execution require independent review of the generated overlay, source hashes, fixed install path and environment. The shared target avoids duplicate caches but a later trial build may overwrite generated root release executables; the normal installer must remain separately preserved. No normal Rust source or Tauri config is changed.

NSIS uses a unique product name, identifier, and main binary name. A trial-only preinstall hook refuses every install location other than the dedicated workspace path, an existing nonempty target, or a running trial executable; it never checks or stops the normal product's sidecar or CLI. Fresh install only is supported. Before launching an installer the caller must independently verify the non-reparse fixed install path, no overlap with normal installs, that trial registry entries and profile are fresh, and the generated installer source and installed files. These protections are not a substitute for the review.

The trial profile and window state use separate Windows known folders keyed by `local.paperdesk.shared-trial`; inherited `WEBVIEW2_*` variables are removed. The optional `PAPEER_SHARED_TRIAL_CDP_PORT` must be a nonzero u16 and only reconstructs loopback CDP flags. The GUI keeps the real USERPROFILE/HOME because changing those breaks WebView startup on this machine. API keys and common AI/CLI settings are stripped or set to the trial root, and PATH is restricted. The P1 local-note scope does not authorize invoking providers or external CLIs.

Offline installation and WebView offline behavior still need actual verification. The trial contains no configured Google connection and is unsigned. Earlier draft refresh/freeze helpers and the identity example were preserved in the generator-cleanup checkpoint; a fresh prepare now writes the complete input manifest and the reviewed hook directly. Existing trial installations and earlier build records are never rewritten by prepare.



