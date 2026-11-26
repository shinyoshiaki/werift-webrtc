# werift-pbt

The property-based testing base every werift package uses (test-only, not
published): the seeded random stream, the seed / replay configuration and the
deep search runner. Packages import it by relative path from their tests
(`../../../../pbt/src` from `tests/pbt/<name>/`).

## Policy (every package)

| | Rule |
| --- | --- |
| Location | One directory per property: `<package>/tests/pbt/<name>/<name>Property.test.ts`. Input generators live in `generator.ts` beside it when the draw is more than a few lines. Shared Arrange stays in the package's `tests/utils.ts`. |
| Random | `seededRandom(seed)` (mulberry32). A `() => number` stream is `seededRandom(seed).next`. No other PRNG and no `Math.random` in a property (mock `Math.random` with `random.next` when the code under test uses it). |
| Seeds | `propertySeeds("WERIFT_<PACKAGE>_<NAME>", { seeds, steps })`: `<PREFIX>_SEEDS` seeds (the CI default, run by `npm test`) from `<PREFIX>_SEED` (default 1), `<PREFIX>_STEPS` operations per seed. |
| Titles | `test.each(cases)(title("<claim>"), ({ seed }) => …)`: `<claim>: seed N (replay: <PREFIX>_SEED=N <PREFIX>_SEEDS=1 <PREFIX>_STEPS=…)`. The replay environment is in the title of a failure; the deep search selects these titles (`SEED_TITLE_PATTERN`). Rows may carry more fields (`{ seed, mode }`, `$mode` in the claim). |
| Retry | A deterministic property (pure, or fake timers) runs without retry: `describe(name, propertyOptions(), …)`, since a seed that fails once is a counterexample. A property on real sockets and real time (the webrtc negotiation fuzz / scenario / model properties) keeps the package's retry in `npm test`; the deep search always runs `--retry=0` and replays a failure alone to tell a load-induced failure (flaky) from a real one. The leak property never retries. |
| Coverage | An oracle that might never fire gets a coverage check: count what the seeds exercised and assert it in `test.skipIf(seedSelected)(…)` after the seeds. |
| Header | The file's TSDoc states the claims, the CI defaults and the variables. |
| Deep search | Each package lists its properties in `tests/pbt/suites.ts` (a `DeepSearchConfig` as default export) and runs them with `npm run pbt:deep` (`npm run pbt:deep` at the root runs every package). |

## Deep search

```bash
cd packages/<package>
npm run pbt:deep                                 # the default suites
npm run pbt:deep -- --suite a,b --seeds 1000 --steps 50 --seed 1 --jobs 12
npm run pbt:deep -- --list                       # suites and their defaults
npm run pbt:deep -- --dry-run                    # the shards, without running them
npm run pbt:deep -- --baseline /tmp/werift-develop [--baseline-runs 3]
```

Each shard is its own vitest process (one file, `--retry=0`, the seed range in
its environment); the shards of every selected suite share one pool of
`--jobs` (default: the CPU count). A failed seed runs again alone; the exit
code is 1 when it fails again. A vitest process that ends abnormally fails its
shard even when every test in its report passed: an exit code other than 0
(for example an unhandled rejection after the assertions), a signal, or no
report (`abnormalExit`). Such a shard runs again alone too.
### Baseline comparison

`--baseline <worktree root>` takes the root of another revision checked out
with `git worktree add --detach <dir> <rev>` (never the active worktree; link
or install its dependencies). Each confirmed failure (it failed again alone)
is replayed in the same package of that worktree with the same file, title
pattern and environment, up to `--baseline-runs` (default 3) times. It is
**pre-existing** — listed with the baseline's result and left out of the exit
code — when the baseline reproduces every form observed on this revision (the
first run and the replay alone):

| Failure | Same form on the baseline |
| --- | --- |
| a failed test | the same test (full name, so seed and replay environment included) whose errors have the same `failureSignature`s |
| errors outside the test results (unhandled errors, failing files and hooks) | each of those errors, by its `failureSignature`; never by the exit code. They are judged apart from the shard's failed tests |
| a signal, no report, an exit code no error explains, an error without a message | no comparable cause: stays confirmed |
| a shard that ran no test | never compared (a wrong pattern of this revision) |

`failureSignature` is the whole cause: error type and name, the full message,
`expected` / `actual`, the file and source line it was thrown at, and the same
of its `cause`. Only ANSI colors, the worktree root, line and column numbers
and millisecond durations are removed, so a flake whose message carries other
run-to-run values stays confirmed. The runner reads these from its own
reporter (`src/deepReporter.mjs`).

A failure the baseline passes, or fails in another form, stays confirmed
(exit 1). There is no known-flake list: a list outlives its evidence, while
the baseline replay re-checks it in every run.

In a shard marked `statistical` (for example the webrtc leak heap slope P3),
only a failure whose errors are all statistical assertions — the message
starts with `STATISTICAL_FAILURE_MARKER` — is judged only against a baseline:
without `--baseline` it is reported as statistical and left out of the exit
code, and its signature has every number replaced by `<n>`. Any other failure
of that shard (an operation that threw, a timeout, a hook, an unhandled error,
a crash) counts as usual. Thresholds are not loosened instead.

A baseline from before the marker fails the same assertion without it. A shard
gives `unmarkedStatistical`, a pattern anchored to that assertion's whole
message; an `AssertionError` without a cause that matches it has the same form
as the marked one. Another assertion or an operation that threw on the baseline
does not match, and the pattern never makes a failure of this revision
statistical.

The output ends with
`summary: <n> confirmed (exit code), <n> pre-existing (...), <n> flaky (passed alone), <n> statistical (...)`.
Exit code 1 when a confirmed failure remains, 2 when the baseline cannot be
used (no package at the same path, vitest not resolvable) or `--baseline` has
no path (missing, empty, followed by another option, or written as
`--baseline=<path>`); in both cases no shard runs.

A suite with a
`prefix` is split by seed range;
one with fixed scenes or other parts gives its own `shards` (see
`packages/webrtc/tests/pbt/suites.ts`).

## API

- `seededRandom(seed)`: `{ next, chance, pick, between, int }`; `SeededRandom`.
- `propertySeeds(prefix, { seeds, steps? })`: `{ seeds, cases, steps, seedSelected, replay, title }`.
- `propertyOptions(timeout?)`: `{ retry: 0, timeout? }`.
- `SEED_TITLE_PATTERN`: the vitest `-t` pattern of the seed titles.
- `STATISTICAL_FAILURE_MARKER`, `isStatisticalError`; type `ReportedError`.
- `runDeepSearch(config, argv)`, `abnormalExit`, `failureSignature`, `sameFailure`, `baselinePackageDir`, `planDeepSearch`, `seedRanges`, `prefixShards`, `parseDeepArgs`; types `DeepSearchConfig`, `DeepSuite`, `DeepShard`, `DeepContext`.
