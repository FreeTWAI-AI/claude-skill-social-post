# Changelog

## v2.4.0 — 2026-08-28

### Added

- Executable structured Chrome bridge commands: `browser-scan-request`, `browser-scan`, `browser-action`, `browser-begin`, `browser-finish` and `browser-reconcile`.
- Append-only, expiring scan-target requests that bind live observations to an independently selected session, account and post.
- Strict action／preflight／receipt binding across permit, session, scope, comment fingerprint and exact reply hash.
- Freshness, integer schema, exact post path／query, composer readback and post-submit causality guards.
- Facebook, Instagram and Threads local HTML contract fixtures plus state-derived fill／click receipts, verified, ambiguous, stale, wrong-parent, wrong-type and reconciliation journeys.
- Credential-shaped public-sync negative controls and explicit browser evidence／trace privacy exclusions.

### Changed

- Active skill ledgers reject raw begin／finish／reconcile commands that bypass the Chrome bridge; those commands remain available only for isolated fixture ledgers.
- A contradictory or partially verified submit can no longer become `sent_verified`; it remains `needs_reconcile` and cannot be blindly retried.
- Reinspection now uses a structured receipt. Uncertain reinspection performs no ledger mutation.
- Preflight evidence must occur after approval and before permit expiry; a failed outcome cannot contradict visible own-reply evidence.

### Boundary

- The bridge prevents accidental stale, cross-post and duplicate actions, but browser observations remain trusted assertions from the current bound Codex Chrome session rather than cryptographic DOM attestation.

## v2.3.0 — 2026-08-28

### Added

- P5 Chrome Comment Ops for Facebook, Instagram and Threads without Meta API integration.
- Append-only comment observations and reply audit state machine.
- Strong／weak comment identity, stale-draft detection, bounded-auto policy and repeated-reply gate.
- One-shot permits scoped to session, platform, account, post, comment and exact reply hash.
- Append-only bounded-auto session grants with exact scope, expiry, revocation and a cumulative action cap.
- `send_started → sent_verified／needs_reconcile` recovery so uncertain browser outcomes are never blindly retried.
- Behavioral tests for cross-platform identity, authorization, idempotency, uncertain sends, optimistic concurrency and dry-run writes.

### Changed

- Public sync is now a closed-world allowlist: new private files are excluded unless explicitly approved.
- Live comment actions use current-session authorization and a finite run cap; private messages and media replies remain out of scope.

### Privacy

- Real comments, replies, authors, post IDs, browser sessions, cookies, tokens, screenshots and local account data are excluded from the public package.

## v2.2.0 — 2026-08-24

### Added

- Append-only factual correction events.
- Machine-readable measurement precision qualifiers.
- Privacy-blocking public sync preflight and managed-file manifest.
- Anonymous public rule／formula starter library and fictional case fixture.

### Changed

- Summary output now displays non-exact play counts with their qualifier.
- Current public tree no longer ships private account cases, outcome archives, personal voice evidence or account-specific platform policy.

### Validation

- Added positive correction materialization, immutable-source, illegal identity mutation, qualifier propagation and privacy preflight tests.

## v2.1.1 — 2026-08-13

- Added account-period snapshots with the same revision, lock and atomic commit path as post outcomes.

## v2.1.0 — 2026-08-13

- Split storage, validation, application and CLI responsibilities.
- Added progressive-disclosure context routes, append-only experiment revisions and config-driven public sync.

## v2.0.0 — 2026-08-11

- Introduced P3 outcome logging, P4 pattern optimization and structured JSONL stores.
