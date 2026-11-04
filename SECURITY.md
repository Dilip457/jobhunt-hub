# Security

## Reporting a problem

Email **heyjarvis.03@gmail.com** with what you found and how to reproduce it. Please do not
open a public issue for a security problem, and please do not test against the refresh
endpoint with password guesses or run load against the site.

## What this site holds

No accounts, no sign-in, no cookies, no database and no personal data from visitors. Job
listings come from public boards. The only secrets are two values held in Vercel's environment
(never in this repo): `GITHUB_TOKEN` and `REFRESH_TOKEN`.

## Owner's checklist

These settings live outside the code, so they are not enforced by anything in this repo. Review
them after any change of token or hosting.

**GitHub account and repo**

- Two-factor authentication on the account, with recovery codes stored offline.
- Branch protection on `main`: require a pull request and the CI checks, block force pushes.
- Secret scanning and push protection on (Settings → Code security).
- Dependabot alerts on. `.github/dependabot.yml` already raises the update pull requests.
- Settings → Emails: "Keep my email addresses private" and "Block command line pushes that expose
  my email", so new commits use the GitHub noreply address.
- Actions → General → Workflow permissions: read-only by default. `scrape.yml` asks for write only
  in its `publish` job.

**Vercel**

- Two-factor authentication on the account.
- `GITHUB_TOKEN`: a fine-grained token limited to this one repo, with Actions read/write and
  Contents read only, and an expiry date. Marked Sensitive. Production environment only.
- `REFRESH_TOKEN`: a long random value (16 or more characters from a password manager), Sensitive,
  Production only. The lockout that protects it is held in memory and resets on a cold start, so a
  short PIN has less protection than it appears to.
- Deployment Protection on preview deployments.
- Firewall: a rate limit on `/api/*` and Bot Protection, to bound bandwidth and invocation costs.

**If a secret may have leaked**

1. Revoke the GitHub token and create a new one, then update it in Vercel and redeploy.
2. Change `REFRESH_TOKEN` in Vercel and redeploy.
3. Check the Actions run history for runs you did not start.

## What the code does

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), section 11, "Security, privacy and cost".
