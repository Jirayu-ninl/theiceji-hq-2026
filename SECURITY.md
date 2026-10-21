# Security

HQ signs people in, runs an OAuth 2.1 authorization server for MCP clients,
and keeps sealed credentials for the services it connects to. Reports of
security issues are welcome.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Include:

- what is affected (an app or package, a route, an MCP tool)
- the steps to reproduce it, and what an attacker gains
- the commit you tested, and any setup it needs

Once a fix is ready, it is released first and the advisory is published
after it.

## Supported versions

Only the latest commit on `main` gets security fixes. There are no release
branches.

## Scope

In scope: everything in this repository, including the sign-in flow, the
OAuth endpoints (`apps/hq/src/app/oauth`, `.well-known`), the MCP server's
gate and scopes (`apps/hq-mcp`, `packages/mcp-kernel`), credential sealing
(`HQ_SEALING_KEY`), and outbound fetches (`packages/net-guard`).

Out of scope: a deployment's own configuration (weak secrets, a database open
to the internet, a missing `CRON_SECRET`), third-party services HQ connects
to, and attacks that need the owner's own session or machine.
