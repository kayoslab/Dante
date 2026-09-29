# Contributing to Dante

Thanks for taking a look. Dante is published as an **example
implementation** — a working reference for organisations whose people
data lives in one system (an HRIS such as Personio), whose time data
lives in another (a project tool such as awork), and who need the two
reconciled into numbers a manager can act on. It is not a product, and
there is no roadmap beyond what the maintainer needs. That said,
contributions that make the reference clearer, safer, or easier to adapt
are very welcome.

## Ways to contribute

- **Report a bug.** Open an issue with what you did, what you expected,
  and what happened. Redact anything that looks like a real name,
  salary, or API token before you paste it.
- **Improve the docs.** Anything that shortens the path from "cloned the
  repo" to "understood how the sync, the reconciliation, and the report
  engines fit together" is valuable.
- **Fix or extend the code.** Bug fixes, hardening, better tests, and
  adapter-style changes (swapping Personio or awork for another source)
  are the most useful kinds of change. Open an issue first for anything
  larger than a few files so we can agree on the shape before you invest
  the time.

## Before you open a pull request

Run the same checks CI runs:

```bash
cd frontend
npm ci
npm run check            # type-check + awork read-only guard + DB-locality guard + tests
npm run build:migrate
npm run build:sync-lambda
npm run build:cognito-pretoken-lambda

cd ..
terraform -chdir=terraform fmt -recursive -check
terraform -chdir=terraform/envs/prod init -backend=false && terraform -chdir=terraform/envs/prod validate
```

Two guards in `npm run check` are deliberate architectural rules, not
lint noise:

- **Integrations are read-only.** A provider adapter under
  `frontend/lib/integrations/providers/<slug>/` may only issue HTTP writes
  from the files it lists in `writesAllowedIn` (awork: `auth.ts`, the
  OAuth token endpoint). Dante never pushes data into an external tool.
- **Database access is local to `lib/db/`.** Pages, Server Actions and
  API routes call named query functions from `lib/db/queries/*`; they do
  not open Drizzle calls themselves.

Keep those intact. If a change genuinely needs to move one of those
boundaries, say so in the PR description and explain why.

## Forks never deploy

The deploy workflow is an explicit opt-in: every job is skipped unless
the repository variable `DEPLOY_ENABLED` is exactly `true`. Your fork
will run the read-only checks and nothing else.

## Pull request expectations

- One concern per PR. A refactor and a behaviour change are two PRs.
- Describe *why* as well as *what*. The commit history in this repo
  leans on explanatory messages; please keep that up.
- Add or update tests for behaviour you touch. Report-engine and
  reconciliation logic in particular should not change without a test
  that would have caught the regression.
- Never commit real employee, salary, absence, or customer data — not in
  fixtures, not in screenshots, not in test names. Use obviously
  synthetic values.
- Never commit secrets. `.env` is git-ignored for a reason; `.env.example`
  documents the variables without values.

## Security

If you find a vulnerability, please do **not** open a public issue. Use
GitHub's private vulnerability reporting ("Report a vulnerability" under
the repository's **Security** tab) and give us reasonable time to fix it
before disclosure.

## License

By contributing, you agree that your contributions are licensed under
the same [MIT License](LICENSE.md) that covers the rest of the project.
