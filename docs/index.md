# Apigee Tools

Apigee Tools provides XML diagnostics and context-aware completion in VS Code, and a read-only [dashboard](#dashboard) of an Apigee organization's deployments. The current alpha is for feedback; it does not replace deployment validation.

## Getting started

Install **Apigee Tools** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=peterschwps.apigee-tools) or [Open VSX](https://open-vsx.org/extension/peterschwps/apigee-tools), then open a proxy or shared flow bundle. XML files under `apiproxy` or `sharedflowbundle` are recognized by their location; supported policy roots can also be recognized in standalone XML files. Use the Problems panel for diagnostics and Ctrl+Space for suggestions. Inside `<Step><Name>`, suggestions list the policies of the same bundle.

## Diagnostics

| ID | Meaning |
| --- | --- |
| AX001 | XML syntax error |
| AX101 | Unknown element or wrong document root in a reviewed context |
| AX102 | Misplaced element |
| AX103 | Unknown attribute |
| AX104 | Missing required attribute or child |
| AX105 | Invalid documented fixed value |
| AX106 | Invalid documented format |
| AX107 | Invalid cardinality, conflicting configuration, or duplicate flow name |
| AX108 | Missing bundle-local policy reference |
| AX109 | Resource absent locally; it may exist at environment scope (warning) |
| AX110 | Deprecated element or documented X compatibility concern (warning) |
| AX111 | RouteRule target endpoint missing from the proxy bundle |
| AX112 | Policy file listed in a proxy or shared flow manifest is missing (warning) |
| AX113 | Policy name does not use the selected prefix for its type (warning) |
| AX114 | Policy file name does not match its root name attribute (error) |

Checks for unknown elements and attributes apply only to complete reviewed contexts. Some references are incomplete or contradictory. A clean result therefore does not prove that Apigee will accept or correctly execute the proxy.

## Policy name prefixes

AX113 checks the policy XML's root `name` attribute against the prefix selected for that policy type, in both proxy and shared flow policies and supported standalone policy XML. Prefixes are case-sensitive and include a hyphen: `AM-SetHeaders` is accepted for AssignMessage; `am-SetHeaders`, `AM_SetHeaders`, and `SA-SetHeaders` are not. File names and `DisplayName` are not checked by this rule.

These prefixes are this linter's convention, not mandatory Apigee syntax. [Google recommends short type prefixes](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/best-practices-api-proxy-design-and-development#naming-conventions), but does not define one complete binding list. The selection draws on the [Apigee naming recommendations](https://discuss.google.dev/t/apigee-naming-convention/17403), [apigeelint's catalogue](https://github.com/apigee/apigeelint/blob/main/lib/package/plugins/policyMetaData.json), and documented examples such as [HTTPModifier's HM prefix](https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/http-modifier-policy). An asterisk marks an additional project choice. Related types may share a prefix.

| Policy root | Prefix |
| --- | --- |
| AccessControl | `AC-` |
| AccessEntity | `AE-` |
| AssertCondition | `AC-` |
| AssignMessage | `AM-` |
| BasicAuthentication | `BA-` |
| CORS | `CORS-` |
| DataCapture | `DC-` |
| DecodeJWS | `JWS-` |
| DecodeJWT | `JWT-` |
| DeleteOAuthV2Info | `DOA-` * |
| ExternalCallout | `EC-` |
| ExtractVariables | `EV-` |
| FlowCallout | `FC-` |
| GenerateJWS | `JWS-` |
| GenerateJWT | `JWT-` |
| GenerateSAMLAssertion | `SAML-` |
| GetOAuthV2Info | `GOA-` * |
| GraphQL | `GQL-` |
| HMAC | `HMAC-` |
| HTTPModifier | `HM-` |
| IntegrationCallout | `INT-` |
| InvalidateCache | `IC-` |
| JavaCallout | `JC-` |
| Javascript | `JS-` |
| JSONThreatProtection | `JTP-` |
| JSONToXML | `J2X-` |
| KeyValueMapOperations | `KVM-` |
| LLMTokenQuota | `LTQ-` |
| LookupCache | `LC-` |
| MessageLogging | `ML-` |
| MessageValidation | `MV-` |
| MonetizationLimitsCheck | `MLC-` * |
| OASValidation | `OAS-` |
| OAuthV2 | `OA-` |
| ParseDialogflowRequest | `PDFR-` |
| ParsePayload | `PP-` * |
| PopulateCache | `PC-` |
| PromptTokenLimit | `PTL-` |
| PublishMessage | `PM-` |
| Script (Python) | `PY-` * |
| Quota | `Q-` |
| RaiseFault | `RF-` |
| ReadPropertySet | `RPS-` |
| RegularExpressionProtection | `RE-` |
| ResetQuota | `RQ-` |
| ResponseCache | `RC-` |
| RevokeOAuthV2 | `OAR-` |
| SanitizeModelResponse | `SMR-` |
| SanitizeUserPrompt | `SUP-` |
| SemanticCacheLookup | `SCL-` |
| SemanticCachePopulate | `SCP-` |
| ServiceCallout | `SC-` |
| SetDialogflowResponse | `SDFR-` |
| SetIntegrationRequest | `SIR-` |
| SetOAuthV2Info | `SOA-` * |
| SpikeArrest | `SA-` |
| TraceCapture | `TC-` |
| ValidateSAMLAssertion | `SAML-` |
| VerifyAPIKey | `VAK-` |
| VerifyIAM | `VIAM-` |
| VerifyJWS | `JWS-` |
| VerifyJWT | `JWT-` |
| XMLToJSON | `X2J-` |
| XMLThreatProtection | `XTP-` |
| XSL | `XSL-` |

Use `--only AX113` in the CLI to find naming warnings, or `--ignore AX113` to suppress them. The extension's `ignore` setting and inline suppression also apply. The quick fix offers suppression; renaming a policy and its references is not automatic.

## Policy file names

AX114 requires the file name without its final `.xml` extension to exactly match the decoded `name` attribute of the policy root, including case. For example, `AM-SetHeaders.xml` with `name="AM-Other"` produces an error on the attribute value. Dots within the name are preserved. This follows [Google's naming conventions](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/best-practices-api-proxy-design-and-development#naming-conventions).

The rule applies only to recognized policies directly under `apiproxy/policies/` or `sharedflowbundle/policies/`. Standalone policy XML is exempt. Syntax errors and missing or empty names are left to existing checks. AX113 and AX114 may both be reported for the same name.

Use `--only AX114` to find mismatches. These are errors and cause CLI exit code 1 unless suppressed through `--ignore AX114`, the extension's `ignore` setting, or an inline directive. The quick fix offers suppression; files, attributes, and references are not renamed automatically.

## Settings

Use VS Code settings or a workspace settings file:

```json
{
  "apigeeTools.enabled": true,
  "apigeeTools.exclude": ["**/generated/**"],
  "apigeeTools.ignore": []
}
```

Add a diagnostic ID to `ignore` to suppress it everywhere. Source links on diagnostics point to the relevant Google documentation.

## Inline suppression

To suppress diagnostics at one location, put a comment on the line before the reported line:

```xml
<RaiseFault name="RF-Fault">
  <!-- apigee-tools disable=AX101 -->
  <Properties/>
</RaiseFault>
```

The comment lists one or more IDs separated by commas, such as `disable=AX101,AX103`. It applies only to the line after the comment ends; other rules on that line are still reported. For a diagnostic on the root element, place the comment before the root. The semantics match apigeelint's `<!-- apigeelint disable=... -->` directive, but each tool only reads its own directive and rule IDs.

## Quick fixes

Use the light bulb or **Ctrl+.** on a diagnostic:

- **Change to "…"** replaces an AX105 value with the single documented value closest to it, such as `flase` with `false`. No fix is offered when no value is close enough or several are equally close; the diagnostic message names the suggestion.
- **Disable … for this line** inserts the inline suppression comment above the reported line, or extends an existing directive there. It is not offered where a comment cannot be placed, such as inside a multi-line start tag or on the XML declaration line.
- **Remove policy reference** removes an AX112 manifest entry, including its line when it contains only that entry.
- **Create policies/….xml** creates and opens an empty file for an AX112 manifest entry. Existing files are preserved. Configure the policy in the new file; this fix checks file existence only.

## Command line

The same checks run outside VS Code with the `@peterschwps/apigee-tools` package. It requires Node.js 20.1 or later:

```sh
npx @peterschwps/apigee-tools path/to/apiproxy path/to/sharedflowbundle
```

In GitHub Actions, run `npx --yes @peterschwps/apigee-tools apiproxy` after `actions/setup-node`. From a checkout of this repository, `npm ci && npm run build && node dist/cli.js path/to/bundles` runs the same command.

Directories are searched recursively for XML under `apiproxy` and `sharedflowbundle`, skipping `node_modules` and `.git`; files given explicitly are always linted. Each finding is printed as `file:line:column: severity rule message`, followed by a summary on standard error. Use `--ignore AX110,AX101` like the `ignore` setting; inline `apigee-tools disable` comments also apply. `--version` prints the installed version.

Use `--only AX112` to report only missing policy files listed in manifests, or `--only AX108,AX112` to include missing flow policy references. Both `--only` and `--ignore` accept comma-separated IDs or repeated options, ignoring case. IDs match exactly; `--ignore` and inline suppression take precedence. The summary and exit code reflect only the reported findings.

```sh
npx @peterschwps/apigee-tools --only AX112 path/to/bundles
```

| Exit code | Meaning |
| --- | --- |
| 0 | No errors; warnings may have been reported |
| 1 | At least one error |
| 2 | Invalid option or unreadable path |


## Dashboard

The dashboard shows what is deployed in an Apigee X organization next to the bundles in your workspace. Open it with **Apigee Tools: Open Dashboard** from the Command Palette, or with **Apigee** in the status bar, which appears in workspaces that contain bundles.

### Requirements

- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) where the extension runs: on your computer, or on the remote host, in WSL, or in the container when you work remotely.
- A sign-in with `gcloud auth login`. Without one, the dashboard offers a button that runs the command in a terminal.
- A role that can read Apigee, such as Apigee Read-only Admin (`roles/apigee.readOnlyAdmin`).

The dashboard selects the organization you chose last in this workspace, otherwise the project of your gcloud configuration, otherwise the first organization the account can access. If the account may not list organizations, the gcloud project comes first. The header switches between organizations and filters the environments.

### Overview and deployments

- **Overview** counts environments, API proxies, shared flows, deployments, and problems. It lists the environments with their type, environment groups and, under pay-as-you-go, their add-ons, and the bundles in the workspace with their lint findings.
- **Deployments** lists the API proxies and the shared flows of the environment chosen at the top, each in a tab that counts the rows shown. Icons show the status of each deployment (Ready, Warnings, Failed, Deploying, Unknown, or Not deployed) and how it compares with the workspace (Same, Differs, or Not compared). Hovering over an icon names it. Filter by name, status, or workspace. A name opens the details of the proxy or shared flow.
- **Details** show the deployments of a proxy or shared flow in every environment with status, revision, deployment time, base paths, and the comparison with the workspace, followed by their errors and warnings in full. The header names the proxy type, Standard or Extensible, which sets the price of a call under pay-as-you-go, and the bundle in the workspace with its lint findings; its buttons open the Apigee console and the local bundle.
- **Warnings:** the deployment is ready, but Apigee reports a base path conflict: another environment in the same environment group serves the same base path, and Apigee routes the requests for it to only one environment. Give the proxies different base paths, or attach the environments to different groups.
- **Unknown:** the status was not checked; a notice above the tabs says why. Opening the details checks it.

### Comparing with local bundles

A bundle in the workspace matches a deployed proxy or shared flow by name: the `name` attribute of the top-level XML file under `apiproxy` or `sharedflowbundle`. Bundles under `node_modules` or `target` and files matching `apigeeTools.exclude` are not counted, and bundles that share a name are not compared; exclude the extra copies. The dashboard downloads each deployed revision of such a bundle once per session and compares it with the saved files. The **Workspace** column shows whether a deployment is the same as the local bundle, differs from it, or was not compared. Where it differs, clicking the icon opens the differing files in VS Code's multi-file diff editor.

XML files of the bundle structure count as different only when their elements, attributes, or values differ; indentation, line endings, attribute order, and comments are ignored. The top-level XML file and `manifests/` are not compared, since Apigee writes them anew on import.

### Settings

| Setting | Use |
| --- | --- |
| `apigeeTools.gcloudPath` | Path to `gcloud` when it is not on the `PATH`, such as `~/google-cloud-sdk/bin/gcloud`. It applies only from user or remote settings, never from a workspace. |
| `apigeeTools.gcloudConfiguration` | A named gcloud configuration, such as one per customer, instead of the active one. |

Organizations with data residency work when gcloud uses their regional endpoint through `gcloud config set api_endpoint_overrides/apigee`; the dashboard uses the same endpoint.

### Data and access

The dashboard runs `gcloud config list` and `gcloud auth print-access-token`, without prompts. The access token stays in memory, is never written to disk or shown, and is sent only to the Apigee API at `apigee.googleapis.com` or a regional Apigee endpoint. The dashboard only reads; it never deploys, undeploys, or changes anything.

Data loads when you open the dashboard, refresh it, or switch the organization; a dashboard restored after restarting VS Code waits until you load it. To spare the API quota, the status is checked for at most 200 deployments per load, local bundles and recent deployments first. A network failure or an exhausted quota stops the remaining checks, and a notice says so.

In Restricted Mode, linting keeps working. The dashboard then lists only the workspace bundles and needs a trusted workspace for everything else.

## Scope and limitations

The extension covers proxy and shared flow manifests, endpoints, flows, shared flows, and policy XML for Apigee X. FlowCallout references to deployed shared flows are not checked. Edge, hybrid-only features, XSLT resource contents, and arbitrary XML payload contents are excluded. Local resource, policy, and target endpoint references use saved bundle files. A RouteRule target matches a target endpoint's name attribute or its file name. Runtime variables, environment resources, and deployment behavior cannot be fully validated statically.

The source inventory currently has 25 documented gaps. Fixtures checked only by this linter cannot establish the platform's actual behavior.
