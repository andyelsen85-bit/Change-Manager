# Additional security scan findings

These automated findings were collected during the baseline remediation. They
are separate from the eight implementation fixes in the supplied plan and
prevent a blanket claim that the entire repository is vulnerability-free.

## Dependency audit

The scan reported **11 critical, 24 high, 21 moderate, and 4 low findings**.
These are advisory counts, not counts of independently exploitable application
paths. Some affect development/build tooling and require attacker-controlled
input that this application does not ordinarily process.

Priorities for a separate dependency update and regression pass:

- **Orval 8.5.3:** eleven critical code-generation advisories and a high
  unrestricted-reference advisory. The scanner recommends 8.22.0 or later
  covering these findings. Do not generate code from untrusted specifications.
- **Nodemailer 8.0.7:** address-parser denial of service and raw-message access
  advisories; the reported complete fix requires a major-version review.
- **Undici 8.7.0:** cache handling advisory; scanner recommends 8.9.0 or later.
- **Vite 7.3.2:** file-deny bypass on Windows; scanner recommends 7.3.5 or later.
- Other high findings involve transitive packages including `fast-uri`,
  `js-yaml`, `postcss`, `brace-expansion`, `browserslist`, `linkify-it`,
  `form-data`, and `nanoid`.

Review the dependency parents and affected runtime paths before upgrading.
Prefer compatible direct-parent updates, regenerate only intended API clients,
and rerun builds and regression tests. No broad dependency upgrade is claimed
as part of this baseline remediation.

## Static analysis

Two medium findings flag redirects in the AD FS authentication routes:
the redirect to the configured identity provider and the post-login return
destination. Review must account for the existing configured provider
validation and `sanitizeReturnTo` checks rather than remove required OIDC
redirects or weaken their validation.

## Privacy/dataflow analysis

The scanner returned no findings. This is not a guarantee that no privacy risk
exists; access policy and operational backup handling still require owner
review.