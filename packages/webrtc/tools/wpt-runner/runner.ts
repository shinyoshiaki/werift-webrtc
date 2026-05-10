import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import * as os from "os";
import { dirname, resolve } from "path";
import vm from "vm";

import {
  MediaStream,
  MediaStreamTrack,
  RTCDataChannel,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCRtpTransceiver,
} from "../../src";
import { Navigator } from "../../src/nonstandard";
import { resolveTargetConcurrency } from "./concurrencyLogic";
import { resolveTimeoutProfile } from "./timeoutLogic";

export interface WptAllowlistFile {
  targets: WptTarget[];
}

export interface WptTarget {
  file: string;
  enabled: boolean;
  reason: string;
  variant?: string;
  subtests?: string[];
}

export interface WptResultRecord {
  file: string;
  variant: string;
  subtest: string;
  status: "PASS" | "FAIL" | "TIMEOUT" | "SKIP";
  message?: string;
}

export interface WptRunReport {
  generatedAt: string;
  summary: {
    passed: number;
    failed: number;
    timedOut: number;
    skipped: number;
    total: number;
  };
  results: WptResultRecord[];
  regressions: WptResultRecord[];
}

const packageDir = process.cwd();
const repoRoot = resolve(packageDir, "..", "..");
const wptRoot = resolve(repoRoot, "third_party", "wpt");
const allowlistPath = resolve(packageDir, "wpt", "allowlist.json");
const baselinePath = resolve(packageDir, "wpt", "baseline.json");
const defaultReportPath = resolve(repoRoot, "coverage", "webrtc-wpt", "results.json");
const PROGRESS_MODE = process.env.WPT_PROGRESS;
const VERBOSE_PROGRESS = PROGRESS_MODE === "verbose";
const TARGET_FILTER = process.env.WPT_TARGET_FILTER;

const IGNORE_SCRIPT_PATHS = new Set([
  "/resources/testharnessreport.js",
  "/resources/testdriver.js",
  "/resources/testdriver-vendor.js",
  "../mediacapture-streams/permission-helper.js",
]);

if (!(globalThis as { __weriftWptUnhandledRejectionHook?: boolean }).__weriftWptUnhandledRejectionHook) {
  process.on("unhandledRejection", () => undefined);
  (globalThis as { __weriftWptUnhandledRejectionHook?: boolean }).__weriftWptUnhandledRejectionHook =
    true;
}

export async function loadAllowlist() {
  return JSON.parse(await readFile(allowlistPath, "utf8")) as WptAllowlistFile;
}

export async function discoverWptTargets() {
  const allowlist = await loadAllowlist();
  const discoveredFiles = await listWptHtmlFiles(resolve(wptRoot, "webrtc"));
  const targets = new Map<string, WptTarget>();

  for (const file of discoveredFiles) {
    const configured = allowlist.targets.find(
      (target) => target.file === file && !target.variant,
    );
    const target: WptTarget = {
      file,
      enabled: true,
      reason:
        configured?.reason ??
        "Auto-discovered upstream WebRTC WPT file executed by the Node.js runner.",
      variant: "",
    };
    targets.set(targetKey(target), target);
  }

  for (const configured of allowlist.targets) {
    if (!configured.variant) {
      continue;
    }
    targets.set(targetKey(configured), {
      ...configured,
      enabled: true,
    });
  }

  return [...targets.values()]
    .filter((target) => {
      if (!TARGET_FILTER) {
        return true;
      }
      return `${target.file}${target.variant ? ` ${target.variant}` : ""}`.includes(
        TARGET_FILTER,
      );
    })
    .sort((left, right) => {
    return (
      left.file.localeCompare(right.file) ||
      (left.variant ?? "").localeCompare(right.variant ?? "")
    );
    });
}

export async function runSelectedWpt(options: {
  compareWithBaseline?: boolean;
  reportPath?: string;
  updateBaseline?: boolean;
} = {}): Promise<WptRunReport> {
  const targets = await discoverWptTargets();
  const results = await runTargets(targets);

  const regressions =
    options.compareWithBaseline === false
      ? []
      : await findRegressions(results);

  const report: WptRunReport = {
    generatedAt: new Date().toISOString(),
    summary: summarize(results),
    results,
    regressions,
  };

  await mkdir(dirname(options.reportPath ?? defaultReportPath), { recursive: true });
  await writeFile(
    options.reportPath ?? defaultReportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (options.updateBaseline) {
    await updateBaseline(results);
  }

  return report;
}

async function runTargets(targets: WptTarget[]) {
  const results: WptResultRecord[] = [];
  const executing = new Set<Promise<void>>();
  const availableParallelism =
    "availableParallelism" in os ? os.availableParallelism() : undefined;
  const targetConcurrency = resolveTargetConcurrency({
    availableParallelism,
    cpuCount: os.cpus().length,
    input: process.env.WPT_CONCURRENCY,
  });
  let completed = 0;

  for (const target of targets) {
    const task = runTarget(target).then((targetResults) => {
      results.push(...targetResults);
      completed += 1;
      if (PROGRESS_MODE && (completed % 10 === 0 || completed === targets.length)) {
        console.error(`[wpt] completed ${completed}/${targets.length}`);
      }
    });
    executing.add(task);
    task.finally(() => {
      executing.delete(task);
    });
    if (executing.size >= targetConcurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results.sort((left, right) => {
    return (
      left.file.localeCompare(right.file) ||
      left.variant.localeCompare(right.variant) ||
      left.subtest.localeCompare(right.subtest)
    );
  });
}

async function runTarget(target: WptTarget): Promise<WptResultRecord[]> {
  if (VERBOSE_PROGRESS) {
    console.error(`[wpt] start ${target.file}${target.variant ? ` ${target.variant}` : ""}`);
  }
  const timeoutProfile = resolveTimeoutProfile(target);
  const htmlPath = resolve(wptRoot, target.file);
  const html = await readFile(htmlPath, "utf8");
  const title = extractTitle(html);
  const { context, mediaDevices, closePeerConnections } = createContext({
    cleanupTimeoutMs: timeoutProfile.cleanupTimeoutMs,
    file: target.file,
    variant: target.variant ?? "",
    title,
  });

  const completion = installHarnessHooks(context, target);
  const scripts = extractScripts(html);

  try {
    for (const script of scripts) {
      if (script.src) {
        if (IGNORE_SCRIPT_PATHS.has(script.src)) {
          continue;
        }
        const scriptPath = resolveScriptPath(htmlPath, script.src);
        const source = await readFile(scriptPath, "utf8");
        vm.runInContext(source, context, {
          filename: scriptPath,
          timeout: timeoutProfile.vmTimeoutMs,
        });
        if (script.src === "/resources/testharness.js") {
          vm.runInContext(
            `
              setup({ explicit_timeout: true, output: false });
              ${harnessPatch}
            `,
            context,
            { timeout: timeoutProfile.vmTimeoutMs },
          );
        }
        continue;
      }

      vm.runInContext(script.content, context, {
        filename: htmlPath,
        timeout: timeoutProfile.vmTimeoutMs,
      });
    }
    if (VERBOSE_PROGRESS) {
      console.error(`[wpt] waiting ${target.file}${target.variant ? ` ${target.variant}` : ""}`);
    }

    return await withTimeout<WptResultRecord[]>(
      completion.done,
      timeoutProfile.completionTimeoutMs,
      [
        {
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[timeout]",
          status: "TIMEOUT",
          message: `WPT file did not finish before the runner timeout (${timeoutProfile.completionTimeoutMs}ms).`,
        },
      ],
    );
  } catch (error) {
    return [
      {
        file: target.file,
        variant: target.variant ?? "",
        subtest: "[exception]",
        status: "FAIL",
        message: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    ];
  } finally {
    if (VERBOSE_PROGRESS) {
      console.error(`[wpt] cleanup ${target.file}${target.variant ? ` ${target.variant}` : ""}`);
    }
    await closePeerConnections();
    mediaDevices.cleanup();
    if (VERBOSE_PROGRESS) {
      console.error(`[wpt] finish ${target.file}${target.variant ? ` ${target.variant}` : ""}`);
    }
  }
}

function createContext(input: {
  cleanupTimeoutMs: number;
  file: string;
  variant: string;
  title: string;
}) {
  const peerConnections = new Set<RTCPeerConnection>();
  const mediaDevices = new Navigator({
    dummyMedia: {
      enabled: true,
    },
  }).mediaDevices;
  const WptRTCPeerConnection = createPeerConnectionWrapper(peerConnections);

  const location = new URL(`https://wpt.local/${input.file}${input.variant}`);
  const sandbox: Record<string, unknown> = {
    AbortController,
    Buffer,
    DOMException,
    Event,
    EventTarget,
    HTMLCanvasElement: class HTMLCanvasElement {},
    META_TITLE: input.title,
    MediaStream,
    MediaStreamAudioDestinationNode: undefined,
    MediaStreamTrack,
    RTCPeerConnection: WptRTCPeerConnection,
    RTCDataChannel,
    RTCIceCandidate,
    RTCRtpReceiver,
    RTCRtpSender,
    RTCRtpTransceiver,
    RTCSessionDescription: createRtcSessionDescriptionClass(),
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    navigator: { mediaDevices },
    location,
    opener: null,
    parent: null,
    performance,
    queueMicrotask,
    self: null,
    setInterval,
    setMediaPermission: async () => undefined,
    setTimeout,
    test_driver: {},
    test_driver_internal: {},
    top: null,
    window: null,
  };

  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.top = sandbox;

  return {
    context: vm.createContext(sandbox),
    mediaDevices,
    closePeerConnections: async () => {
      await Promise.allSettled(
        [...peerConnections].map((pc) =>
          withTimeout(
            Promise.resolve(pc.close()),
            input.cleanupTimeoutMs,
            undefined,
          ),
        ),
      );
    },
  };
}

function createRtcSessionDescriptionClass() {
  return class RTCSessionDescription {
    readonly type: string;
    readonly sdp: string;

    constructor(init: { type?: string; sdp?: string } = {}) {
      if (!init?.type) {
        throw new TypeError("RTCSessionDescriptionInit.type is required");
      }
      this.type = init.type;
      this.sdp = init.sdp ?? "";
    }

    toJSON() {
      return {
        type: this.type,
        sdp: this.sdp,
      };
    }
  };
}

function createPeerConnectionWrapper(peerConnections: Set<RTCPeerConnection>) {
  class WptRTCPeerConnection extends RTCPeerConnection {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      peerConnections.add(this);
    }

    override addIceCandidate(
      ...args: Parameters<RTCPeerConnection["addIceCandidate"]>
    ) {
      const promise = super.addIceCandidate(...args);
      promise.catch(() => undefined);
      return promise;
    }

    override async close() {
      try {
        await super.close();
      } finally {
        peerConnections.delete(this);
      }
    }
  }

  for (const eventName of [
    "ondatachannel",
    "onicecandidate",
    "onicecandidateerror",
    "onicegatheringstatechange",
    "onnegotiationneeded",
    "onsignalingstatechange",
    "ontrack",
    "onconnectionstatechange",
    "oniceconnectionstatechange",
  ] as const) {
    defineEventAttribute(WptRTCPeerConnection.prototype, eventName);
  }

  return WptRTCPeerConnection;
}

function defineEventAttribute(target: object, name: string) {
  const storageKey = Symbol(name);
  Object.defineProperty(target, name, {
    get(this: Record<PropertyKey, unknown>) {
      return this[storageKey] ?? null;
    },
    set(this: Record<PropertyKey, unknown>, value: unknown) {
      this[storageKey] = value ?? undefined;
    },
    configurable: true,
    enumerable: true,
  });
}

function installHarnessHooks(context: vm.Context, target: WptTarget) {
  const runtime = context as vm.Context & Record<string, any>;
  const done = new Promise<WptResultRecord[]>((resolve, reject) => {
    runtime.__wptComplete = (
      tests: Array<{ name: string; message: string; status: number }>,
      status: { message?: string; status: number },
    ) => {
      const resultRecords = tests.map((test) => ({
        file: target.file,
        variant: target.variant ?? "",
        subtest: test.name,
        status: mapStatus(test.status),
        message: test.message || undefined,
      })) as WptResultRecord[];

      if (status.status !== 0) {
        resultRecords.push({
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[harness]",
          status: "FAIL",
          message: status.message || "WPT harness reported an error.",
        });
      }

      resolve(resultRecords);
    };
    runtime.__wptFailure = (error: Error) => reject(error);
  });

  runtime.__wptSelectTest = (_name: string) => true;

  return {
    done,
  };
}

const harnessPatch = `
  add_completion_callback((tests, status) => globalThis.__wptComplete(tests, status));
  for (const name of ["promise_test", "async_test", "test"]) {
    const original = globalThis[name];
    globalThis[name] = function wrappedTest(testBody, testName, properties) {
      if (typeof testName === "string" && !globalThis.__wptSelectTest(testName)) {
        return;
      }
      return original.call(this, testBody, testName, properties);
    };
  }
`;

function extractScripts(html: string) {
  const scripts: Array<{ src?: string; content: string }> = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    const [, attributes, content] = match;
    const srcMatch = attributes.match(
      /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
    );
    scripts.push({
      src: srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3],
      content,
    });
  }

  return scripts;
}

function extractTitle(html: string) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() || "Untitled";
}

function resolveScriptPath(htmlPath: string, src: string) {
  if (src.startsWith("/")) {
    return resolve(wptRoot, `.${src}`);
  }
  return resolve(dirname(htmlPath), src);
}

async function findRegressions(results: WptResultRecord[]) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    results: WptResultRecord[];
  };
  const byKey = new Map(
    baseline.results.map((result) => [resultKey(result), result.status]),
  );

  return results.filter((result) => {
    if (result.status === "SKIP") {
      return false;
    }
    const expected = byKey.get(resultKey(result));
    if (!expected) {
      return false;
    }
    return isRegression(expected, result.status);
  });
}

async function updateBaseline(results: WptResultRecord[]) {
  await writeFile(
    baselinePath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results: results.filter((result) => result.status !== "SKIP"),
      },
      null,
      2,
    )}\n`,
  );
}

function resultKey(result: Pick<WptResultRecord, "file" | "variant" | "subtest">) {
  return `${result.file}::${result.variant}::${result.subtest}`;
}

function isRegression(
  expected: WptResultRecord["status"],
  actual: WptResultRecord["status"],
) {
  return statusRank(actual) < statusRank(expected);
}

function statusRank(status: WptResultRecord["status"]) {
  switch (status) {
    case "PASS":
      return 3;
    case "SKIP":
      return 2;
    case "FAIL":
      return 1;
    case "TIMEOUT":
      return 0;
  }
}

function mapStatus(status: number): WptResultRecord["status"] {
  switch (status) {
    case 0:
      return "PASS";
    case 2:
      return "TIMEOUT";
    default:
      return "FAIL";
  }
}

function summarize(results: WptResultRecord[]) {
  const summary = results.reduce(
    (acc, result) => {
      switch (result.status) {
        case "PASS":
          acc.passed += 1;
          break;
        case "FAIL":
          acc.failed += 1;
          break;
        case "TIMEOUT":
          acc.timedOut += 1;
          break;
        case "SKIP":
          acc.skipped += 1;
          break;
      }
      return acc;
    },
    { passed: 0, failed: 0, timedOut: 0, skipped: 0 },
  );
  return {
    ...summary,
    total: summary.passed + summary.failed + summary.timedOut + summary.skipped,
  };
}

export function hasWptRegressions(report: Pick<WptRunReport, "regressions">) {
  return report.regressions.length > 0;
}

export function formatMarkdownReport(report: WptRunReport) {
  const fileSummary = summarizeByFile(report.results)
    .filter((file) => file.failed > 0 || file.timedOut > 0)
    .sort((left, right) => {
      return (
        right.failed - left.failed ||
        right.timedOut - left.timedOut ||
        left.file.localeCompare(right.file)
      );
    })
    .slice(0, 20);

  const lines = [
    "# WPT WebRTC summary",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    `| PASS | ${report.summary.passed} |`,
    `| FAIL | ${report.summary.failed} |`,
    `| TIMEOUT | ${report.summary.timedOut} |`,
    `| SKIP | ${report.summary.skipped} |`,
    `| REGRESSION | ${report.regressions.length} |`,
    `| TOTAL | ${report.summary.total} |`,
    "",
    hasWptRegressions(report)
      ? "**Result:** failed due to regressions against the recorded WPT baseline."
      : "**Result:** success (there may still be upstream WPT failures, but no regressions were detected).",
  ];

  if (fileSummary.length > 0) {
    lines.push(
      "",
      "## Files with failures or timeouts",
      "",
      "| File | PASS | FAIL | TIMEOUT |",
      "| --- | ---: | ---: | ---: |",
      ...fileSummary.map(
        (file) =>
          `| ${file.file}${file.variant ? ` ${file.variant}` : ""} | ${file.passed} | ${file.failed} | ${file.timedOut} |`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function printTargetList(targets: WptTarget[]) {
  console.log(`# WPT WebRTC targets (${targets.length})`);
  console.log("");
  for (const target of targets) {
    const variant = target.variant ? ` ${target.variant}` : "";
    console.log(`- ${target.file}${variant}`);
  }
}

async function listWptHtmlFiles(directoryPath: string, parent = ""): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    const absolutePath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWptHtmlFiles(absolutePath, relativePath)));
      continue;
    }
    if (relativePath.endsWith(".html")) {
      files.push(`webrtc/${relativePath}`);
    }
  }

  return files;
}

function targetKey(target: Pick<WptTarget, "file" | "variant">) {
  return `${target.file}::${target.variant ?? ""}`;
}

function summarizeByFile(results: WptResultRecord[]) {
  const byFile = new Map<
    string,
    {
      file: string;
      variant: string;
      passed: number;
      failed: number;
      timedOut: number;
    }
  >();

  for (const result of results) {
    const key = `${result.file}::${result.variant}`;
    const entry =
      byFile.get(key) ??
      {
        file: result.file,
        variant: result.variant,
        passed: 0,
        failed: 0,
        timedOut: 0,
      };
    switch (result.status) {
      case "PASS":
        entry.passed += 1;
        break;
      case "FAIL":
        entry.failed += 1;
        break;
      case "TIMEOUT":
        entry.timedOut += 1;
        break;
      case "SKIP":
        break;
    }
    byFile.set(key, entry);
  }

  return [...byFile.values()];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolveFallback) => {
        timer = setTimeout(() => resolveFallback(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
