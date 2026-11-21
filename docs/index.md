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

These prefixes are this linter's convention, not mandatory Apigee syntax. [Google recommends short type prefixes](https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/best-practices-api-proxy-design-and-development#naming-conventions), but does not define one complete binding list. The selection draws on the [Apigee naming recommendations](https://discuss.google.dev/t/apigee-naming-convention/17403), [apigeelint's catalogue](https://github.com/apigee/apigeelint/blob/main/lib/package/plugins/policyMetaData.json), and documented examples such as [HTTPModifier's HM prefix](https://docs.cloud.google.com/apigee/docs/api-platform/reference/policies/http-modifier-policy). Related types may share a prefix.

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

\* Chosen by this project: none of the sources above names a prefix for this policy type.

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

- **Overview** counts environments, API proxies, shared flows, deployments, and problems. It lists the failed deployments and warnings with their messages; a name opens the details.
- **Deployments** lists the API proxies and the shared flows of the environment chosen at the top, each in a tab that counts the rows shown. Icons show the status of each deployment (Ready, Warnings, Failed, Deploying, Unknown, or Not deployed) and how it compares with the workspace (Same, Differs, Not compared, or Not in workspace). Hovering over an icon names it. Filter by name above the table, and by status or workspace with the filter icon in their column header. The Name header sorts ascending or descending, and a name opens the details of the proxy or shared flow.
- **Details** show the deployments of a proxy or shared flow in every environment with status, revision, deployment time, base paths, and the comparison with the workspace, followed by their errors and warnings in full. The header names the proxy type, Standard or Extensible, which sets the price of a call under pay-as-you-go, and the path of its bundle in the workspace; its buttons show it in Relationships and open the Apigee console and the local bundle.
- **Warnings:** the deployment is ready, but Apigee reports a base path conflict: another environment in the same environment group serves the same base path, and Apigee routes the requests for it to only one environment. Give the proxies different base paths, or attach the environments to different groups.
- **Unknown:** the status was not checked; a notice above the tabs says why. Opening the details checks it.

### Comparing with local bundles

A bundle in the workspace matches a deployed proxy or shared flow by name: the `name` attribute of the top-level XML file under `apiproxy` or `sharedflowbundle`. Bundles under `node_modules` or `target` and files matching `apigeeTools.exclude` are not counted, and bundles that share a name are not compared; exclude the extra copies. The dashboard downloads each deployed revision of such a bundle once per session and compares it with the saved files. The **Workspace** column shows whether a deployment is the same as the local bundle, differs from it, was not compared, or has no bundle in the workspace. Where it differs, clicking the icon opens the differing files in VS Code's multi-file diff editor.

XML files of the bundle structure count as different only when their elements, attributes, or values differ; indentation, line endings, attribute order, and comments are ignored. The top-level XML file and `manifests/` are not compared, since Apigee writes them anew on import.

### Relationships

**Relationships** shows how the parts of an organization depend on each other, in five columns: developers (app groups among them), apps, API products, API proxies, and shared flows. An app leads to the API products that its API keys are for. It answers questions that the Apigee console spreads over many pages:

- Whom does a change to a proxy, shared flow, or API product affect?
- Why does a call fail with 401 or 403: is the app revoked, the key expired or waiting for approval, the product not available in the environment, or the proxy not deployed?
- Which app and developer does an API key belong to?
- What can be cleaned up: apps without keys, API products without keys or proxies, proxies in no product, and keys that are revoked, expired, or expire within 30 days?

The tab follows the environment chosen at the top. Proxies and shared flows show their deployment status there, and the shared flows a proxy calls are those of the revision deployed there. A plug icon marks the shared flows attached to a flow hook.

Choose a node to see only its chain: everything it uses and everything that uses it. A panel shows its details, its neighbors, and what keeps the chain from working; for an app, also its API keys. To keep a chain in view while you look at its nodes, right-click a node and choose **Pin**: choosing other nodes then changes only the panel, until **Unpin** in the menu of the pinned node or **Show All**. **Show All** shows everything again, and so does Escape in the graph while no chain is pinned; without a choice, the panel lists the findings of all columns. Each column is one Tab stop: the up and down arrows move within it, the left and right arrows to a connected node. In the details of a proxy or shared flow, **Show in Relationships** opens its chain.

Search by name, email, attribute as `name=value`, such as `tier=gold`, or the last characters of an API key, which finds its app. If nothing matches, Enter looks up the text as a full API key and chooses its app. The details of an app list its keys by their last four characters, each with its state and a button that copies the full key.

A dashed line in the warning color leads from an app to an API product that its keys wait for approval of, a dotted line in the error color to one that no working key of the app may use. For a chosen chain or a search, plain dashed lines lead from its proxies to the shared flows of the environment's flow hooks.

- Each column shows at most 100 nodes, the chosen, found, and troubled ones first; search or choose a node to see others.
- Shared flow calls come from the FlowCallout policies of the deployed revisions. Names set through variables are not resolved, and a FlowCallout counts even when no step runs it.
- Apigee lists at most 1,000 developers; app owners beyond them show without name or status.

### Settings

| Setting | Use |
| --- | --- |
| `apigeeTools.gcloudPath` | Optional path to the CLI executable: `gcloud.cmd` on Windows, `gcloud` on macOS/Linux. Leave empty to detect it on the extension host's `PATH`.  |
| `apigeeTools.gcloudConfiguration` | A named gcloud configuration, such as one per customer, instead of the active one. |

The dashboard and sign-in action resolve the CLI from `PATH` unless an explicit path is set. Restart VS Code after changing `PATH`. In WSL, SSH, or Dev Containers, the CLI must be available where the extension runs.

Organizations with data residency work when gcloud uses their regional endpoint through `gcloud config set api_endpoint_overrides/apigee`; the dashboard uses the same endpoint.

### Data and access

The dashboard runs `gcloud config list` and `gcloud auth print-access-token`, without prompts. The access token stays in memory, is never written to disk or shown, and is sent only to the Apigee API at `apigee.googleapis.com` or a regional Apigee endpoint. The dashboard only reads; it never deploys, undeploys, or changes anything.

Data loads when you open the dashboard, also when VS Code restores it after a restart, when you refresh it, or when you switch the organization. To spare the API quota, the status is checked for at most 200 deployments per load, local bundles and recent deployments first. A network failure or an exhausted quota stops the remaining checks, and a notice says so. Notes above the tabs close with their × button and stay hidden until you close the dashboard; a note whose text changes shows again.

The Relationships tab loads its data the first time it opens, and with every load after that: API products, developers, app groups, apps with their API keys, flow hooks, and the deployed revisions, whose FlowCallout policies name the shared flows they call. It downloads at most 200 revisions per load, recent deployments first, and each revision once per session; a notice says when a refresh reads more. Consumer secrets are discarded on arrival. Full API keys stay in the memory of the extension: the tab receives only their last four characters, and copying a key or looking one up happens in the extension, without a request to the API. The search text is not saved.

In Restricted Mode, linting and the flow of local bundles keep working, and the dashboard asks for a trusted workspace.

## Flow

**Show Flow** draws how Apigee runs the flows of an API proxy or shared flow, in a tab of its own. Open it with the button in the title bar of an XML file of a bundle, with **Apigee Tools: Show Flow** from the Command Palette, or with **Show Flow** in the details of a proxy or shared flow in the dashboard. The tab shows the bundle of the file it was opened from, and draws it again when you save one of its files. **Back** and **Forward** in its top-left corner return to the bundles shown before.

### Reading the flow

Each proxy endpoint gets a list of what runs, in the order Apigee runs it:

- **Request:** the PreFlow, conditional Flows, and PostFlow of the proxy endpoint, the route rules, and the flows of the target endpoint.
- **Backend:** where the target endpoint sends the request, such as a URL, the servers of a load balancer, or another proxy.
- **Response:** the flows of the target endpoint, then those of the proxy endpoint, back to the client.
- **Per Event**, **On Error**, and **After the Response** show the EventFlow for server-sent events, the fault handling of each endpoint, and the PostClientFlow, when the bundle has them.

Conditional flows, route rules, and fault rules are listed in the order Apigee checks them, and the first match runs: fault rules from the bottom up in a proxy endpoint and from the top down in a target endpoint, followed by the DefaultFaultRule. Since only one of them runs, their cases branch apart from one line; a single case stands alone. A case without a condition matches everything, so the cases after it are marked as never running; when no route rule catches every other request, Route Rules gets an error sign, since such a request fails. A route rule shows its name and where it sends the request: **default → Target Endpoint** is the route rule named default, which sends the request to the target endpoint. An endpoint named default, as most are, goes by its kind alone. Route rules are buttons: choose one to draw the target it leads to, or none for a null route.

The stations of each section, such as a flow hook, an endpoint, and the route rules, hang on a line; the steps of each part stand below one another in the order they run. A step with a condition has a dashed border with the condition below it, and a disabled policy is muted. Every part starts expanded; the arrow before it collapses it, and **Collapse All** next to Refresh folds every station, so that the list shows only the stations. A step opens its policy, and the title of an endpoint opens its file, in the editor group to the right of the flow, always the same one; the row you opened stays marked. Hovering over a row names its policy type, its condition, and what else matters, and Cmd+F (Ctrl+F) finds a policy by its name.

### The map

Above the list, a map shows the way through the proxy endpoint at a glance, and stays at the top while you scroll: the request from the client to the right, the response below it back to the client, and the backend on the right where the request turns. An arrow on each connection points the way. A route rule without a target endpoint turns at **No Target** instead. On Error, Per Event, and After the Response get a row of their own when the proxy has them. A station with a dashed border runs no steps, and a sign on a station says that something in it differs from the workspace or needs attention. The map marks the station whose part of the list is at the top; choose a station to show it in the list, opened. A shared flow has no map, since it has only its steps.

### Keyboard

The map is one Tab stop: the arrow keys choose a station, and Enter shows it in the list. The list works like VS Code's trees: the up and down arrows move from row to row, the right arrow opens a part or enters it, the left arrow closes it or goes to the part around it, and Enter does what a click does.

### Workspace and environments

**Source** switches between the local copy, **Workspace**, and each environment where the proxy or shared flow is deployed, such as **eval · Revision 2**. The environments come from the organization of the dashboard; until it has loaded, **Load Environments** loads it. An environment shows the flow of its deployed revision with:

- the shared flows of the environment's flow hooks, where they run, with their revisions and the steps of those revisions;
- the revision of each shared flow that a FlowCallout calls, or an error sign where it is not deployed, since the call then fails;
- the status of the deployment and a mark on each policy, resource, or endpoint file that differs from the local copy. The button beside **Source** opens the differing files in VS Code's diff editor, or the sign says that they are the same.

Steps that only the local copy has are not drawn in an environment; the mark on the endpoint and the diff show them.

### What the flow view assumes

Google's documentation leaves some behavior open, so the flow view assumes:

- Pre-Target and Post-Target flow hooks run around the flows of the target endpoint. Where a route has no target endpoint, they get a question mark.
- Flow hooks do not run in the error flow.
- The EventFlow runs for each event; how it is ordered with the response flows is not shown.
- The policies that a PostClientFlow allows are not checked.
- Of several policies with one name, the one in the file named after it counts.

### Data

The flow of the local copy reads only files of the workspace: it needs no sign-in, works in Restricted Mode, and sends nothing over the network. An environment reads its deployed revision once per session, shared with the comparisons of the dashboard, its four flow hooks once until you refresh, and the deployed revision of each shared flow attached to them once per session.

## Scope and limitations

The extension covers proxy and shared flow manifests, endpoints, flows, shared flows, and policy XML for Apigee X. FlowCallout references to deployed shared flows are not checked. Edge, hybrid-only features, XSLT resource contents, and arbitrary XML payload contents are excluded. Local resource, policy, and target endpoint references use saved bundle files. A RouteRule target matches a target endpoint's name attribute or its file name. Runtime variables, environment resources, and deployment behavior cannot be fully validated statically.

The source inventory currently has 25 documented gaps. Fixtures checked only by this linter cannot establish the platform's actual behavior.
