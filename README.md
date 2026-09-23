# maui2rn

A local Node.js/TypeScript CLI and MCP server for planning and staging .NET MAUI to React Native migrations. It analyzes MAUI XAML and C# with Roslyn syntax and a partial semantic compilation, creates a React Native native template, generates deterministic screens and service scaffolds, and records findings in an exact proposal. The optional Codex specialists review one page and produce a revised proposal using ChatGPT login. Applying a high risk proposal requires an exact visual review receipt or an explicit CLI acknowledgment.

This is a migration harness. Generated placeholders for commands, service behavior, assets, native APIs, authentication, and unsupported controls are deliberately visible and must be implemented and tested before shipping an app.

## Requirements

- Node.js 22.13+, 24.3+, or 26+ and npm (the React Native 0.87.1 runtime requirement).
- .NET 9 SDK for the Roslyn helper. The helper restores `Microsoft.CodeAnalysis.CSharp` from NuGet on first run; MAUI workloads are **not** needed for source analysis.
- Network access for first install, Roslyn restore, and native React Native template creation.
- Optional: `codex login` with a ChatGPT subscription for `assist`. `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the specialist process environment; the CLI never reads `.env` files.
- Android SDK/JDK for an Android native build. macOS and Xcode are required to build iOS; on Windows the harness can scaffold and typecheck iOS source but cannot compile or run it.

## Install and use

From this directory:

```powershell
npm ci
npm run verify
node dist/cli.js analyze C:\path\to\MauiSolution.sln --out C:\path\to\report.json
node dist/cli.js scaffold --name MyMigratedApp --out C:\path\to\MyMigratedApp
node dist/cli.js convert --report C:\path\to\report.json --app C:\path\to\MyMigratedApp
```

`convert` prints a proposal path. Open the JSON proposal and `migrationReport.json` to review generated code and findings. To ask the four read only Codex specialists for a revised screen proposal:

```powershell
node dist/cli.js assist --report C:\path\to\report.json --proposal C:\path\to\MyMigratedApp\.maui2rn\proposals\ID.json --page MainPage
```

The specialists cover view conversion, state, services, and verification. Completed steps are checkpointed under `.maui2rn/agent-runs/` and reused when the same command is retried. An active run has a lock file; remove a leftover lock only after confirming the prior process exited. The harness validates the view candidate's syntax, export, size, and imports and marks it high risk. This step requires an authenticated Codex CLI account and may consume subscription usage. It does not write to the React Native source tree.

To review every proposed file and finding in a local browser, run:

```powershell
node dist/cli.js review --proposal C:\path\to\MyMigratedApp\.maui2rn\proposals\ID.json
```

Open the printed `127.0.0.1` URL. The page shows current and proposed content side by side. Approve each file, then record the review receipt. The server binds only to loopback and closes after recording the receipt. It does not apply code.

After review, apply the specific proposal:

```powershell
node dist/cli.js apply --proposal C:\path\to\MyMigratedApp\.maui2rn\proposals\ID.json --accept-template --review-receipt
cd C:\path\to\MyMigratedApp
npm install
npx tsc --noEmit
npx react-native run-android
```

The harness can run repeatable JavaScript checks and write a JSON gate report:

```powershell
node C:\path\to\maui2rn\dist\cli.js verify-app --app C:\path\to\MyMigratedApp
```

This typechecks the app, runs Jest, and makes release-mode Metro bundles for Android and iOS. Add `--android-native` on a machine with an Android SDK to run `gradlew assembleDebug` as well. It exits nonzero while a check fails or high severity migration findings remain. The report and bundles are under `.maui2rn/verify/`. Passing the default checks permits a native build attempt; it does not replace device testing or native compilation.

`--accept-template` is needed only for the first apply, when the generated `App.tsx`, `package.json`, and `jest.config.js` still match their hashes captured during scaffolding. High severity findings require `--review-receipt` after visual review or `--approve-high-risk` after independent review. The receipt is bound to every file hash; changing a proposal invalidates it. The CLI refuses locally edited managed files instead of overwriting them. Applied file hashes and proposal IDs are stored in `.maui2rn/manifest.json`.

After implementing a flagged behavior, run `status --app C:\path\to\MyMigratedApp` to see its finding ID. Record a specific fix and verification using `resolve --app C:\path\to\MyMigratedApp --id ID --evidence "..."`. Resolutions are saved in `.maui2rn/resolutions.json`. A newer proposal may introduce new findings; its high severity items block the verification gate until resolved.

`scaffold --skip-install` creates the native template without installing app dependencies, useful for offline review. Install dependencies before typechecking or building.

## MCP host setup

Run a local stdio server with:

```text
command: node
args: ["C:\\absolute\\path\\to\\maui2rn\\dist\\cli.js", "mcp"]
```

For Codex, add the same command and args to `~/.codex/config.toml` (replace the example path):

```toml
[mcp_servers.maui2rn]
command = "node"
args = ["C:\\path\\to\\maui2rn\\dist\\cli.js", "mcp"]
```

Restart the host, list MCP tools, and call `analyze_maui_project` with an absolute path to a test MAUI project. The host starts the process; stdout is reserved for MCP. The server uses `@modelcontextprotocol/server` 2.0.0 with `serveStdio` and negotiates modern `2026-07-28` or legacy clients. It exposes `analyze_maui_project`, `generate_rn_scaffold`, and `prepare_conversion`. Applying a proposal remains a CLI operation so a model cannot set its own review acknowledgment. There is no HTTP transport or remote authentication surface.

The MCP tool paths are local paths with the same filesystem access as the launching user. Configure the server only in a trusted local host. No data or secrets are written to stdout other than MCP responses. The `assist` feature is not exposed as an MCP tool.

If analysis fails, check `dotnet --version` (9.x required), network access to NuGet for the first Roslyn restore, and that the input directory contains a `.csproj`. If scaffolding fails, check npm access and remove the failed, partially created target directory before retrying. If `assist` fails with login errors, run `codex login status` in the same user account. `verify-app` needs `npm install` to have completed inside the generated app.

## What analysis and conversion cover

- `.csproj` target frameworks, project references, package references; recursively discovered MAUI source files.
- `ContentPage` trees, basic Shell routes, simple `{Binding Property}` expressions, and command names.
- Roslyn semantic extraction for locally declared types, collection item keys, `ObservableProperty` fields, validation attributes, and simple `RelayCommand` actions. Unavailable MAUI references keep syntax spelling. `x:DataType` takes precedence in ViewModel mapping, and unresolved bindings become findings.
- Deterministic mappings for labels, entries, editors, search bars, switches, buttons, basic layouts, scroll views, simple collections, activity indicators, navigation registration, required-field feedback, stable list keys, and simple literal-route command navigation. Unsupported buttons are visibly disabled.
- A simple GET adapter for literal `GetStringAsync` and `GetFromJsonAsync` calls. Service findings remain high until auth, error, retry, cancellation, and response contracts are verified.
- Generated `src/domain/parityManifest.json` maps source pages, bindings, commands, and routes to target screens and device checks. `src/domain/nativeIntegrationPlan.json` identifies supported API families and their verification recipes.
- Local per-file visual review with hash-bound receipt; resumable, read-only Codex specialist runs.
- React Native 0.87.1 native app template with the New Architecture runtime, feature screens, navigation dependencies, domain migration report, and service scaffolds.
- File-hash guarded proposal/apply flow, high risk findings, unsupported-control markers, and MCP protocol test.

## Limits and production gates

- Roslyn partially resolves project-local types. It does not load MAUI assemblies, follow runtime DI graphs, or reproduce XAML resource dictionaries, converters, behaviors, or full Shell navigation semantics. Generated `ObservableProperty` members are inferred from attributes rather than compiled source generators.
- The generated screen uses local state as a migration starting point. Complex `ICommand` behavior, non-required validation, persistence, authentication, image assets, item templates, deep links, and custom native controls require manual code. Unsupported service methods throw a clear pending error until implemented.
- `CollectionView` renders basic text items. It uses an `Id`/`[Key]` property when found; otherwise it uses an index and raises a high severity finding. Review templates, selection, pagination, and accessibility.
- A native Android/iOS release build, device flow comparison, security review, and package compatibility check must be done on the actual target app. This repository's fixture is illustrative, not evidence for a real MAUI migration.
- The optional AI specialists operate on local source content through the Codex SDK. Review their proposals as untrusted code before applying.
- Brownfield embedding is outside the generated template. Native host integration depends on the real MAUI application and platform strategy.

## Verification

`npm run verify` checks TypeScript, tests Roslyn/XAML extraction, simple command/validation/HTTP conversion, exact review receipts, approval and edit protection, and drives the compiled MCP stdio process through a real client using modern protocol negotiation. Fixtures are in `fixtures/SampleMaui` and `fixtures/BehaviorMaui`. GitHub Actions runs this suite on Windows and Linux. For a native smoke, scaffold a temporary app, convert a fixture, install the generated app dependencies, run `verify-app`, and build on a configured platform. The parity manifest lists device flows that still need human verification.

## References

- [React Native Community CLI init options](https://github.com/react-native-community/cli/blob/main/docs/commands.md)
- [React Native 0.82 New Architecture only release](https://reactnative.dev/blog/2025/10/08/react-native-0.82)
- [React Native native modules](https://reactnative.dev/docs/the-new-architecture/pure-cxx-modules)
- [MCP TypeScript SDK v2 server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md)
- [Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
