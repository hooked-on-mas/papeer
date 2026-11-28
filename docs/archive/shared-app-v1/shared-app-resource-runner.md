# Isolated canonical PDF resource runner

After final source review and all other runtimes have stopped, capture a fresh exclusive source snapshot from the repository root:

```powershell
python frontend/scripts/capture-canonical-pdf-source-manifest.py output/canonical-pdf-resource-reviewed.json
$env:PDF_SPIKE_SOURCE_MANIFEST = 'output/canonical-pdf-resource-reviewed.json'
node frontend/scripts/test-canonical-pdf-resources-isolated.mjs
```

The capture helper reads installed source, includes the parser fixture and its own script, excludes docs and output, and refuses to overwrite the destination. Review its printed hash and file count before running. Earlier 907-file draft snapshots are not the installed source freeze. Node 24 is required; finite TAP parser fixtures are included in the ordinary frontend test glob. The executor owns the run and must inspect the output lock and owned processes after any failure before allowing another run. A six-case result requires all six fresh processes and cooperative cleanup; it is not evidence about OS descendants or prior runs.

The runner preserves default 25-second ready, 15-second navigation and 180-second case budgets and clears the calibration flag. The Ink-contact suite includes a PDF/paper seed rejected by the current translation validator; only the separately selected PDF/PDF case is eligible for focused evaluation until a legal same-Reader paper fixture is designed. Neither the runner nor Ink input is accepted solely by installation.
