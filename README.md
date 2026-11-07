# Quorum

A feature-flag service with percentage rollouts, weighted variants, and an append-only
audit log. Flags are evaluated locally from a hash, so an evaluation costs microseconds and
two servers running the same flag set always agree.

Zero dependencies — standard library only.

## Run it

Requires Node 24+.

```bash
node --test           # test suite
node src/server.ts    # listens on :4000
```

```bash
# Roll a flag out to 10% of users
curl -X POST localhost:4000/flags -H 'content-type: application/json' \
  -d '{"key":"checkout.v2","state":"ramp","rollout":10000}'

# Ask whether one user is in
curl 'localhost:4000/flags/checkout.v2/evaluate?subject=user-42'
```

## The hard part: ramping without churn

The obvious implementation hashes the subject into the range `0..100` and compares it to the
percentage. That looks right and is wrong: the hash depends on the percentage you pass in,
so every time you raise the rollout, users who were already enabled get re-shuffled and
some of them are switched off. That produces bug reports from people who saw the feature
yesterday and cannot see it today.

Quorum hashes `flagKey:subjectId` into a fixed `0..99_999` space, **independently of the
rollout**, then tests `bucket < rollout`. Because the bucket never moves, raising 10% to 50%
can only add subjects. The test suite asserts exactly this over 2,000 subjects instead of
trusting the reasoning.

Rollouts are stored in thousandths of a percent (`100_000` = 100%), so a 0.1% canary is
representable. `percentToBuckets` converts for callers who think in percent.

## API

| Method and path | Behaviour |
| --- | --- |
| `GET /health` | Readiness plus flag count. |
| `GET /flags` | All flags, sorted by key. |
| `POST /flags` | Create. `201` with the flag; `400` on a bad key, rollout or variant set. |
| `GET /flags/:key` | One flag, or `404`. |
| `PATCH /flags/:key` | Partial update; bumps `version` and appends an audit entry. |
| `DELETE /flags/:key` | `204`, or `404` if it was already gone. |
| `GET /flags/:key/evaluate?subject=...` | `{ enabled, variant, reason, bucket, version }`. |
| `GET /flags/:key/audit` | Every change, oldest first, each with a full post-change snapshot. |

Every evaluation returns a `reason` (`flag_not_found`, `flag_off`, `flag_on`,
`rollout_included`, `rollout_excluded`) so a support engineer can answer "why did this user
see that?" without guessing.

## Design decisions

**Unknown flags are disabled, not errors.** A typo in a flag name must not take a page down.
`reason: "flag_not_found"` distinguishes the typo from a deliberate `off`.

**Variants are salted separately.** The variant point uses
`flagKey:subjectId:variant`, so variant assignment does not correlate with rollout
membership — otherwise everyone in the first 10% of the bucket would get the same variant.

**Audit snapshots, not diffs.** Each entry stores the whole flag after the change, so history
can be replayed into a fresh instance without reconstructing a chain of patches.

**Reads return copies.** `get`, `list` and `audit` hand back `structuredClone`s. A caller
mutating a returned flag cannot corrupt stored state or rewrite history.

**Weights must sum to 100.** A variant set that sums to 97 is almost always a typo, and
silently normalising it hides the mistake until a user sees a variant nobody configured.

## Tests

Bucketing stability across instances, rollout monotonicity (the 10% → 50% → 100% subset
property), distribution accuracy at 25% over 10,000 subjects, sub-percent canaries,
variant weighting, version bumps, audit ordering and immutability, delete-keeps-history,
JSON round-trip equivalence, and validation of keys, states, rollouts and variant weights —
plus the HTTP surface: creation, evaluation, audit, `400` on bad input, `404` on unknown
flags and routes.
