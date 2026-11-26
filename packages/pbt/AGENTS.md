# AGENTS.md

## Purpose

Instructions for coding agents working in `packages/pbt`.

## Scope

* The property-based testing base of every package (`src/random.ts`, `src/seeds.ts`, `src/deep.ts`, `src/cli.ts`). Test-only and private: never imported from a package's `src`.
* The rules every property test follows (location, seeds, titles, retry, deep search) are in `README.md`.

## Do

1. Keep `seededRandom`'s stream unchanged: every recorded seed of every package replays through it (`tests/random.test.ts` pins its first values). Add helpers only by combining `next`.
2. Keep the seed variables, the title format and `SEED_TITLE_PATTERN` in step: `runDeepSearch` selects seeds by them in every package.
3. When a rule of `README.md` changes, update the packages' property tests and their `tests/pbt/suites.ts` in the same change.
4. Write tests as Arrange / Act / Assert with Japanese Act / Assert comments.

## Don't

* Don't keep runtime state in module scope (root `AGENTS.md`).
* Don't add a package-local PRNG or seed helper elsewhere; extend this package.

## Commands

| Task | Command |
| --- | --- |
| test package (types and unit tests) | `npm test` |
| type-check package | `npm run type` |
| format package | `npm run format` |

## Validation

* Any change: `npm test` here (the `--baseline` tests build a temporary baseline worktree under `tests/fixtures/.baseline-*`), then `npm run pbt:deep -- --dry-run` in a package with custom shards (`packages/webrtc`) and the property tests of the packages it affects.

## Maintenance

* Keep this guide aligned with `package.json` scripts and `README.md`.
