# Security Policy

If you discover a security vulnerability, please report it
**privately** via GitHub: <https://github.com/peterschwps/Apigee-Tools/security/advisories/new>.

Do not file public issues for security problems.

## Credentials and network access

The linter and the command-line tool work offline. The VS Code dashboard runs `gcloud` to read the signed-in account and an access token. The token is kept in memory only, never written to disk or logged, and sent only to the Apigee API at `apigee.googleapis.com` or a regional Apigee endpoint. The dashboard only reads from the API. In Restricted Mode, it does not run `gcloud`.

The Relationships tab of the dashboard reads apps with their API keys. Consumer secrets are discarded as soon as they arrive. Full API keys stay in the memory of the extension and are never written to disk or logged; the dashboard view receives only their last four characters, and a key reaches the clipboard only when you copy it.
