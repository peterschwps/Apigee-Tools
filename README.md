# Apigee Tools

Apigee Tools checks Apigee X proxy and shared flow XML against Google's Apigee documentation in VS Code and the terminal, with completion and quick fixes in the editor. A read-only dashboard shows what is deployed in your Apigee organization and where it differs from your local bundles.

**Alpha:** validation is based on reviewed Google documentation and is intentionally incomplete where the documentation is ambiguous. A clean result does not prove that Apigee will deploy or correctly execute a proxy.

## Quick Start

1. Install **Apigee Tools** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=peterschwps.apigee-tools) or, for VSCodium and other editors, from [Open VSX](https://open-vsx.org/extension/peterschwps/apigee-tools). VS Code 1.96 or later is required.
2. Open a proxy or shared flow bundle and an XML file under `apiproxy/` or `sharedflowbundle/`.
3. Check the **Problems** panel for diagnostics. Use **Ctrl+Space** for completion suggestions and **Ctrl+.** for quick fixes.

To build a VSIX from source, see the [development guide](docs/development.md).

## Dashboard

Run **Apigee Tools: Open Dashboard** from the Command Palette, or click **Apigee** in the status bar. The dashboard opens as an editor tab:

- **Overview:** key figures, the environments with their groups and, under pay-as-you-go, their add-ons, and the lint findings of the bundles in your workspace.
- **Deployments:** the API proxies and the shared flows of the environment chosen at the top, each in a tab, with status, revision, failures and warnings, and whether each deployment is the same as in your workspace. Filter by name, status, or workspace; where a deployment differs, its icon opens the differing files side by side.

The dashboard needs the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth login`, and a role that can read Apigee, such as Apigee Read-only Admin (`roles/apigee.readOnlyAdmin`). The access token stays in memory and is sent only to the Apigee API. Data loads when you open or refresh the dashboard, never in the background, and nothing is deployed or changed. See the [dashboard section](docs/index.md#dashboard) for details.

## Settings

- `apigeeTools.enabled`: enable or disable diagnostics and completion.
- `apigeeTools.exclude`: ignore matching file paths, also as bundles in the dashboard.
- `apigeeTools.ignore`: suppress selected diagnostic IDs, such as `AX110`.
- `apigeeTools.gcloudPath`: path to `gcloud` for the dashboard, if it is not on the `PATH`.
- `apigeeTools.gcloudConfiguration`: a named gcloud configuration for the dashboard instead of the active one.

To suppress a diagnostic at one location, add `<!-- apigee-tools disable=AX101 -->` on the line before it, or use the quick fix. AX105 typos also offer a fix to the closest documented value.

Apigee Edge, hybrid-only configuration, and validation of embedded payload content are outside scope. The linter reads local XML and does not fetch documentation at runtime; only the dashboard contacts the Apigee API, and it never deploys or changes anything. Current coverage includes 78 documentation sources, with 25 explicitly recorded gaps.

For CI, the same checks run from the command line: `npx @peterschwps/apigee-tools path/to/bundles` exits with 1 when errors are found. See the [command-line section](docs/index.md#command-line).

See the [user guide](docs/index.md) and the [development guide](docs/development.md).

Report problems through [GitHub Issues](https://github.com/peterschwps/Apigee-Tools/issues), including a minimal XML example without credentials or private data.

An independent community project, not affiliated with Google.
