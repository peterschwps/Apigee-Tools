# Development

Run `npm ci`, `npm run check`, `npm test`, and `npm run build`. Press F5 to launch an Extension Development Host. The `watch` task, which starts when the folder opens once automatic tasks are allowed (or with **Tasks: Run Task**), rebuilds the extension and the dashboard on every change with esbuild: an open dashboard reloads by itself and keeps its data, while changes to the extension need a restart of the debug session. `npm run package:alpha` builds a local pre-release VSIX without publishing it.

TypeScript sources are formatted with Prettier. Run `npm run format` before committing; `npm run check` fails on unformatted files.

## Code structure

- `src/xml.ts` converts parser output to a small position-aware XML model.
- `src/spec.ts` defines and loads reviewed rule data.
- `src/linter.ts` validates XML without depending on VS Code.
- `src/completion.ts` generates suggestions for incomplete XML.
- `src/bundle.ts` checks saved bundle-local references.
- `src/directives.ts` applies inline `apigee-tools disable` comments.
- `src/fixes.ts` computes quick-fix edits without depending on VS Code.
- `src/extension.ts` handles VS Code settings, events, and diagnostics.
- `src/gcloud.ts` runs `gcloud` for the dashboard and keeps the access token in memory; `src/apigee.ts` is the read-only Apigee API client; `src/revision.ts` unzips deployed revisions and compares them with local bundles. None of them depends on VS Code.
- `src/dashboard.ts` hosts the dashboard webview, and `src/protocol.ts` types the messages between the extension and the webview.
- `src/webview/` contains the dashboard UI (Lit and VS Code Elements). It has its own `tsconfig.json` with DOM types, and `npm run build:webview` bundles it into `dist/webview`.
- `src/cli.ts` runs the same checks from the command line; it is built to `dist/cli.js` and excluded from the VSIX. `npm run package:npm` stages the npm package of the CLI and checks its contents and the installed command; CI runs this check on every push.
- `scripts/docs.ts` maintains the documentation inventory and candidates; `scripts/validate-reviewed.ts` checks the reviewed rule data for `npm run check`.
- `test/` contains `node:test` suites; `test/fixtures/bundle` and `test/fixtures/sharedflow` are a proxy and a shared flow bundle that must lint without findings. `test/fixtures/revision.zip` is the fixture bundle as a deployed revision; after changing the bundle, rebuild it from `test/fixtures/bundle` with `zip -r -X -fd -n .yaml ../revision.zip apiproxy`, which stores the YAML file uncompressed so that both entry methods stay covered.
- `npm run build` writes `dist/ThirdPartyNotices.txt` with the licenses of the bundled dependencies; the VSIX and the npm package ship it.

TypeScript strict mode is enabled, together with checks for unused code and implicit returns. Rule data stays separate from behavior, and documentation tooling stays outside the runtime package. Keep code, comments, diagnostics, documentation, and commit messages in English.

## Documentation maintenance

1. Run `npm run docs:refresh` to compare Google documentation with saved section hashes, then `npm run docs:discover` to find new pages.
2. Run `npm run docs:extract` and `npm run docs:propose`. Raw candidates are local-only; proposals are explicitly unreviewed and excluded from the VSIX.
3. Review each proposal against current Google Apigee X documentation. Copy confirmed facts into `data/reviewed`, preserving ancestry, source links, and completeness flags. Record unresolved details in `data/sources.json`.
4. Run `npm run check`. With candidates present, this also checks documentation anchors. Extraction updates the hash baseline; refresh does not.

`npm run release:check` validates inventory status, reviewed data, and comparison coverage. Passing does not resolve documented gaps or replace editor/package checks.

`data/comparison/apigeelint.json` records the review of [apigeelint](https://github.com/apigee/apigeelint): the package version and plugin hashes, a disposition for every upstream rule, the source-gap assessments, and the apigee-samples commit used for comparison. Google's documentation stays authoritative; apigeelint is optional evidence for development and never a runtime dependency. `npm run comparison:validate` checks the record as part of `check` and `release:check`. To rerun the comparison, install the recorded apigeelint version with `npm install --prefix .cache/apigeelint-runner --no-save --package-lock=false --ignore-scripts apigeelint@VERSION`, check out the recorded samples commit in `.cache/apigee-samples`, and run `npm run compare:apigeelint`. It verifies both, runs apigeelint with `--profile apigeex`, and writes `.cache/apigeelint-comparison.json`.

## Documentation site

Build the pages locally with an isolated MkDocs 1.x environment:

```sh
uv tool run --with "mkdocs-material>=9,<10" "mkdocs>=1.6,<2" build --strict
```

## Tests

`npm test` runs the suites with Node's built-in test runner. Add a failing case before fixing a bug, and extend the fixture bundle only with XML that Apigee X accepts. CI runs `check`, `test`, and `build` on pushes to `main` and on pull requests.

`npm run test:integration` builds the extension, downloads VS Code 1.96.0 (the engine floor) into `.cache/vscode-test`, and runs `test/integration/suite.ts` in a real extension host against a temporary workspace. It covers diagnostics, quick fixes, and Step/Name completion through the VS Code API, and opens the dashboard with a fake `gcloud` script and a stubbed Apigee API, so it never needs a network or an Apigee organization. The dashboard case is skipped on Windows, where the fake `gcloud` cannot run. CI runs it in a separate job under `xvfb-run`; locally on Linux without a display, prefix the command with `xvfb-run -a`.

## Trying the dashboard against Apigee

`scripts/test-org.ts` sets up a free Apigee X evaluation organization to try the dashboard against. It needs `gcloud`, signed in with `gcloud auth login`, and a Google Cloud project with a billing account. The organization is created without VPC peering and without internet access, so no billable network resources are set up; Google deletes it after 60 days.

```sh
npx tsx scripts/test-org.ts provision PROJECT_ID
npx tsx scripts/test-org.ts populate PROJECT_ID
npx tsx scripts/test-org.ts status PROJECT_ID
npx tsx scripts/test-org.ts delete PROJECT_ID --yes
```

Provisioning takes up to 40 minutes. `populate` adds an environment `test` in a group `test-group`, deploys the fixture proxy `hello` unchanged to `eval` and with one changed policy to `test`, and deploys the shared flow `traffic-shared` to `eval`. In the Extension Development Host, open the dashboard on this repository: `hello` matches the local bundle in `eval` and differs from it in `test`.
