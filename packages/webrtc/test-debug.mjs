import { buildWptProgressState } from './tools/wpt-runner/progress.ts';

const fullReport = {
  generatedAt: "2026-05-13T00:00:00.000Z",
  summary: { passed: 1, failed: 1, timedOut: 0, skipped: 0, total: 2 },
  results: [
    { file: "webrtc/partial.html", variant: "", subtest: "passes", status: "PASS" },
    { file: "webrtc/partial.html", variant: "", subtest: "fails", status: "FAIL", message: "boom" },
  ],
  regressions: [],
};

const filteredReport = {
  generatedAt: "2026-05-13T00:01:00.000Z",
  summary: { passed: 0, failed: 1, timedOut: 0, skipped: 0, total: 1 },
  results: [
    { file: "webrtc/partial.html", variant: "", subtest: "fails", status: "FAIL", message: "still broken" },
  ],
  regressions: [],
};

const previousState = buildWptProgressState(fullReport, undefined, {});
console.log("Previous subtests:", previousState.targets[0].subtests.map(s => s.name));

const nextState = buildWptProgressState(filteredReport, previousState, {
  attemptFilter: "webrtc/partial.html",
  canonical: false,
});

console.log("Next subtests:", nextState.targets[0].subtests.map(s => s.name));
console.log("Counts:", { pass: nextState.targets[0].pass, fail: nextState.targets[0].fail, total: nextState.targets[0].total });
