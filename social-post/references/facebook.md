# Facebook

> last_verified: 2026-08-24
> scope: durable workflow only; re-check official product UI and limits before live publishing.

## Drafting

- Pick one intent: reach, discussion, relationship, lead or sale.
- Use the media and first lines to make the premise understandable before expanding.
- Do not present external-link suppression or a fixed best time as universal law; test against the account's own data.

## Publishing

- Preview the final copy, audience, media and destination before sending.
- Live publication needs current-session confirmation.
- Record the final caption and timestamp in `posts.jsonl`; later insights become new snapshots.

## Measurement

Keep Facebook-only metrics separate from Meta combined cards. Report reaction, comment, share and click scopes exactly as displayed.

## P5 Chrome comment replies

- Follow `comment-operations.md`; enter through the exact post permalink and verify the active identity.
- Treat Enter as a possible send action. Persist `send_started` before it, and keep the approved reply on one line.
- Mark `sent_verified` only after the exact reply is visible under the intended comment; otherwise stop in `needs_reconcile`.
