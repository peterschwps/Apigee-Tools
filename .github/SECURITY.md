# Security Policy

If you discover a security vulnerability, please report it
**privately** via GitHub: <https://github.com/peterschwps/Apigee-Tools/security/advisories/new>.

Do not file public issues for security problems.

## Credentials and network access

The linter and the command-line tool work offline. The VS Code dashboard runs `gcloud` to read the signed-in account and an access token. The token is kept in memory only, never written to disk or logged, and sent only to the Apigee API at `apigee.googleapis.com` or a regional Apigee endpoint. The dashboard only reads from the API. In Restricted Mode, it does not run `gcloud`.
