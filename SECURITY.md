# Security

## Trust model

htmlz is **not designed to be exposed to the public internet.** Its
security model is "the URL is the credential on a network where you
trust everyone who can reach the server." The unguessable suffix on
each slug carries ~50 bits of entropy, which is enough to prevent
guessing in a normal network but is **not** designed to resist a
determined attacker who can run automated scans against the box.

Deploy htmlz behind one of:

- A WireGuard / OpenVPN / Tailscale / ZeroTier network.
- Cloudflare Access or a similar zero-trust proxy.
- A private cloud subnet (AWS VPC, GCP VPC, etc.) with no public ingress.
- A home LAN behind a NAT router.

Do **not** deploy htmlz on a public IP, on a `0.0.0.0`-bound port
exposed to the internet, or behind only "obscure the URL" protection.

## What's in scope

Bugs in:

- The slug entropy or generation (e.g. predictable suffixes).
- The widget injection middleware (e.g. injection into non-page
  responses, breaking the security of legitimate API responses).
- The text-edit path resolver (e.g. ways to write outside the addressed
  text node, or to write to files outside `DATA_ROOT`).
- The static mount or any route handler (e.g. path-traversal that
  exposes the manifest or comments files).
- The CLI installers (e.g. shell-injection through the templated
  `{{BASE}}`).

## What's out of scope

- Lack of authentication. This is **by design** — see the trust model
  above.
- "Anyone with the URL can edit/delete." This is the documented
  sharing model.
- Lack of rate limiting, DoS protection, or audit-trail tamper-resistance.
  Bring those at the network or proxy layer if you need them.

## Reporting

Please report vulnerabilities privately through
[GitHub Security Advisories](../../security/advisories/new). Public
issues are fine for bugs that don't have a clear security impact.

I'll acknowledge within a few days, and aim to ship a fix within two
weeks for anything that materially weakens the trust model.
