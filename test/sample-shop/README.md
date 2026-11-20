# Sample shop

An invented online shop for trying Apigee Tools. Open this folder in VS Code, or start **Run Apigee Tools (sample shop)** from the repository, to see the linter at work. Deploy it to a free Apigee X evaluation organization with `scripts/test-org.ts` to see the dashboard with real data. All hosts lie under the reserved domain `shop.example`, so nothing resolves.

The layout follows Cloud Code: proxies in `src/main/apigee/apiproxies`, shared flows in `src/main/apigee/sharedflows`, one folder per environment in `src/main/apigee/environments` with `deployments.json`, `targetservers.json` and `flowhooks.json`, and API products, developers and apps in `src/main/apigee/tests/shop`. `archive/status` is a forgotten copy of the status proxy.

## Linter findings

Each deliberate finding has a comment such as `<!-- expect AX101: … -->` on the line above it. `npm test` checks that the CLI reports exactly these findings, so all other files must stay clean.

| Bundle | Findings | What it shows |
| --- | --- | --- |
| customers | AX101, AX103 | Typos in an element and an attribute name, which Apigee accepts silently |
| admin | AX102 | A second `<BasePath>` outside `<HTTPProxyConnection>`; the deployment fails |
| shipping | AX104, AX106, AX110 ×2 | SpikeArrest without `Rate`, a `Rate` of "fast" that makes the deployment fail, `UseEffectiveCount` false, and `ExclusiveCache` |
| cart | AX107 | Two flows with the same name |
| inventory-soap | AX109 | An XSD that only the eval environment provides |
| partner-gateway | AX111 | A route rule to a target endpoint that does not exist |
| LegacyStorefront | AX112, AX113 | An Edge-style manifest that names a deleted policy and a policy name without prefix; a second one is suppressed with `apigee-tools disable` |
| reviews | AX001, AX105, AX108, AX114 | Work in progress that Apigee would reject; AX105 offers a "Did you mean" fix |
| audit-draft | AX108 | A draft shared flow without descriptor whose step names an audit policy that is not written yet |

inventory-soap also has a policy with a byte order mark and CRLF line endings and an ISO-8859-1 XSL file. Neither may show as a difference from the deployed revision.

## In the organization

`npx tsx scripts/test-org.ts populate PROJECT_ID` deploys the shop, and `status` lists every deployment. The dashboard should show:

| Bundle | eval | test |
| --- | --- | --- |
| catalog-v1, customers, cors, quota-per-app | Ready | Ready |
| catalog-v2 | Revision 4, matches the local bundle | Revision 2, differs from the local bundle |
| orders-v1 | Revision 2, matches | Revision 1; Compare shows one changed, one added and one removed file |
| security-baseline | Revision 2, matches | Revision 1, differs |
| status | Ready | Ready; the duplicate in `archive/` prevents any comparison |
| payments, inventory-soap, partner-gateway, logging | Ready | Not deployed |
| shipping | Failed: invalid SpikeArrest rate, the AX106 finding | Failed in the same way |
| admin | Failed with a MarshalFailure, the AX102 finding | Not deployed |
| LegacyStorefront | Not deployed | Ready |
| cart | Not deployed | Not deployed |
| reviews, audit-draft | Only in the workspace | |

A newly provisioned evaluation organization also contains Google's `hello-world` proxy. It is not part of the shop and appears without a local bundle.

The environments differ on purpose:

- **Target servers:** only eval has `payments-backend` with mutual TLS and `inventory-backend`. Only test has `legacy-soap` and the disabled `legacy-soap-standby`.
- **TLS:** eval has the keystore `payments-mtls` with two aliases that Apigee generated, valid for 365 and 14 days, and the reference `payments-keystore`.
- **KVM:** `shop-settings` exists in both environments with different values.
- **Resource file:** only eval has `inventory.xsd`.
- **Flow hooks:** `security-baseline` runs before every proxy in both environments, `logging` after every proxy only in eval.

Two API products are created:

- `catalog-free` is approved automatically.
- `partner-gold` needs manual approval, so the credential of `partner-portal` stays pending.

Three developers each have one app. `mobile-app` is revoked.

The Relationships tab should show:

- The key of `partner-portal` waits for approval of `partner-gold`, and `mobile-app` is revoked. Searching `tier=gold` finds `partner-portal`.
- `catalog-v1` and `catalog-v2` call `cors`, and `orders-v1` calls `quota-per-app`. `partner-gateway` calls both in eval; in test it is not deployed.
- `security-baseline` has the flow hook icon in both environments, `logging` only in eval.
- `admin`, `cart`, `customers`, `inventory-soap`, `LegacyStorefront`, `payments`, `shipping`, and `status` are in no API product.

The flow view should show:

- `orders-v1`: in eval, revision 2 is the same as the workspace, between the Pre-Proxy flow hook `security-baseline` and the Post-Proxy flow hook `logging`. In test, revision 1 runs `AM-LegacyOrderHeader` instead of `JS-ValidateOrder`; the proxy endpoint, that step, and `security-baseline` at revision 1 are marked, and 3 files differ.
- `catalog-v2` in test: revision 2 marks `AM-CatalogVersion`, and `JS-PageLinks` through `page-links.js`; 2 files differ.
- `shipping`: the route rule `ratesFromCarrier` is a null route; following it ends the request at the route rules.
- `LegacyStorefront`: the PreFlow of the target endpoint, its fault rule under On Error, and the load balancer with its fallback server.
- `customers`: the fault rule `insufficientScope` under On Error.
- `status`: from a file in `archive/`, the flow of that copy; from the dashboard, no local copy, since two bundles share the name.
- `partner-gateway`: the route rule `orders` leads to a target endpoint that does not exist.
- `reviews`: offline and signed out, the flow of the workspace with the missing policy `JS-MaskProfanity`.
- `cart`: the two conditional flows named `addItem` as cases 2 and 3.

`npx tsx scripts/test-org.ts conflict PROJECT_ID on` also attaches test to `eval-group`. Every proxy deployed in both environments then shows Warnings in test, because its base path conflicts with the deployment in eval. Turn it off with `conflict PROJECT_ID off` before the next `populate`.

Nothing sends requests to the proxies. In an evaluation organization without VPC peering, that would need billable networking, so debug sessions and analytics stay empty.
