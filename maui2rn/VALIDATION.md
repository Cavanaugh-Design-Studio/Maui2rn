# Validation record — 2026-09-23

Environment: Windows, Node.js 24.7.0, npm 11.5.1, .NET SDK 9.0.306. Direct dependencies are pinned in `package.json` and `package-lock.json`.

## Harness 0.2.0

- `npm run verify`: passed TypeScript check, build, and five tests. Tests cover the sample and behavior fixtures, Roslyn semantic extraction, known command navigation, required validation, collection keys, simple HTTP conversion, exact visual review receipts, proposal edit protection, and a real MCP stdio client.
- `npm audit --omit=dev --audit-level=high`: found 0 vulnerabilities on this run.
- `.github/workflows/verify.yml` runs the harness suite on Windows and Linux. Hosted CI has not run from this local checkout.
- The review HTTP server was exercised with a GET and receipt POST. Browser appearance and actual user interaction were not separately inspected.
- The resumable Codex specialist checkpoints were implemented but not exercised in a new live SDK run in this revision. The earlier 0.1.0 live specialist run is recorded in the prior validation history.

## Generated React Native 0.87.1 app

- A fresh app was scaffolded under `work/EnhancedApp` with real Android and iOS template directories, then dependencies were installed.
- The `SampleMaui` fixture proposal applied. `verify-app` passed TypeScript, Jest, Android bundle, and iOS bundle. The gate returned nonzero with three unresolved high findings (search command, list key, service behavior).
- The `BehaviorMaui` fixture proposal then applied to the same temporary app. `verify-app` again passed TypeScript, Jest, Android bundle, and iOS bundle. The gate returned nonzero with two unresolved high findings (HTTP integration contract and service behavior). The latest report is in the temporary app's `.maui2rn/verify/report.json`.
- The richer fixture has a known navigation command, required field, list item ID, and simple JSON GET. The generated code compiled and bundled. It does not prove runtime behavior parity.

## Production limits

No Android native build or device test was run because `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and `adb` were unavailable here. The optional `verify-app --android-native` path is implemented but untested in this environment. iOS native compilation requires macOS/Xcode. No real MAUI solution was supplied; both fixtures are illustrative. The high findings must be implemented and verified in a real target app before calling a migration release ready.
