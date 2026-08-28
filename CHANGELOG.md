# Changelog

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
