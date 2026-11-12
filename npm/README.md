# Apigee Tools CLI

Command-line linter for Apigee X proxy and shared flow bundle XML. It runs the same checks as the [Apigee Tools VS Code extension](https://github.com/peterschwps/Apigee-Tools): structure, documented values and formats, cardinality, and bundle-local policy, target endpoint, and resource references. Every rule is based on reviewed Google Cloud Apigee documentation.

**Alpha:** validation is intentionally incomplete where the documentation is ambiguous. A clean result does not prove that Apigee will deploy or correctly execute a proxy.

## Usage

Node.js 20.1 or later is required.

```sh
npx @peterschwps/apigee-tools path/to/apiproxy path/to/sharedflowbundle
```

Directories are searched recursively for XML under `apiproxy` and `sharedflowbundle`, skipping `node_modules` and `.git`; files given explicitly are always linted. Without a path, the current directory is checked.

Each finding is printed as `file:line:column: severity rule message`, followed by a summary on standard error:

```text
apiproxy/policies/FC.xml:2:12: error AX105 Expected one of: true, false. Did you mean "false"?
1 file checked: 1 error, 0 warnings.
```

| Exit code | Meaning |
| --- | --- |
| 0 | No errors; warnings may have been reported |
| 1 | At least one error |
| 2 | Invalid option or unreadable path |

Use `--ignore AX110,AX101` to skip rules and `--version` to print the installed version. To suppress a finding at one location, put `<!-- apigee-tools disable=AX101 -->` on the line before it.

Use `--only AX112` to report only missing policy files listed in manifests, or `--only AX108,AX112` to include missing flow policy references:

```sh
npx @peterschwps/apigee-tools --only AX108,AX112 path/to/bundles
```

Both `--only` and `--ignore` accept comma-separated IDs or repeated options, ignoring case. IDs match exactly; `--ignore` and inline suppression take precedence. The summary and exit code reflect only the reported findings.

Use `--only AX113` to find policy names missing the selected prefix for their type (for example, `AM-` for AssignMessage). These case-sensitive prefixes are a linter convention, not mandatory Apigee syntax; see the [complete prefix table](https://github.com/peterschwps/Apigee-Tools/blob/main/docs/index.md#policy-name-prefixes).

## GitHub Actions

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: 24
- run: npx --yes @peterschwps/apigee-tools apiproxy
```

## More information

See the [rule reference and user guide](https://github.com/peterschwps/Apigee-Tools/blob/main/docs/index.md) and report problems through [GitHub Issues](https://github.com/peterschwps/Apigee-Tools/issues), including a minimal XML example without credentials or private data.

An independent community project, not affiliated with Google. Licensed under MIT.
