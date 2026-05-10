import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import vm from "vm";
import { fileURLToPath } from "url";

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
  };
  results: WptResultRecord[];
  regressions: WptResultRecord[];
}

const toolDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(toolDir, "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const wptRoot = resolve(repoRoot, "third_party", "wpt");
const allowlistPath = resolve(packageDir, "wpt", "allowlist.json");
const baselinePath = resolve(packageDir, "wpt", "baseline.json");
const defaultReportPath = resolve(repoRoot, "coverage", "webrtc-wpt", "results.json");

const IGNORE_SCRIPT_PATHS = new Set([
  "/resources/testharnessreport.js",
  "/resources/testdriver.js",
  "/resources/testdriver-vendor.js",
  "../mediacapture-streams/permission-helper.js",
]);

export async function loadAllowlist() {
  return JSON.parse(await readFile(allowlistPath, "utf8")) as WptAllowlistFile;
}

export async function runSelectedWpt(options: {
  compareWithBaseline?: boolean;
  reportPath?: string;
  updateBaseline?: boolean;
} = {}): Promise<WptRunReport> {
  const allowlist = await loadAllowlist();
  const results: WptResultRecord[] = [];

  for (const target of allowlist.targets.filter((candidate) => candidate.enabled)) {
    results.push(...(await runTarget(target)));
  }

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

async function runTarget(target: WptTarget) {
  const htmlPath = resolve(wptRoot, target.file);
  const html = await readFile(htmlPath, "utf8");
  const title = extractTitle(html);
  const { context, mediaDevices, closePeerConnections } = createContext({
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
        vm.runInContext(source, context, { filename: scriptPath });
        if (script.src === "/resources/testharness.js") {
          vm.runInContext(
            `
              setup({ explicit_timeout: true, output: false });
              ${harnessPatch}
            `,
            context,
          );
        }
        continue;
      }

      vm.runInContext(script.content, context, { filename: htmlPath });
    }

    return await withTimeout(completion.done, 90_000, [
      {
        file: target.file,
        variant: target.variant ?? "",
        subtest: "[timeout]",
        status: "TIMEOUT",
        message: "WPT file did not finish before the runner timeout.",
      },
    ]);
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
    await closePeerConnections();
    mediaDevices.cleanup();
  }
}

function createContext(input: { file: string; variant: string; title: string }) {
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
      await Promise.allSettled([...peerConnections].map((pc) => pc.close()));
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
  const skipped: WptResultRecord[] = [];
  const selected = new Set(target.subtests ?? []);
  const selectedNames = new Set<string>();

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

      for (const subtest of selected) {
        if (!selectedNames.has(subtest)) {
          resultRecords.push({
            file: target.file,
            variant: target.variant ?? "",
            subtest,
            status: "FAIL",
            message: "Selected subtest was not registered by the upstream WPT file.",
          });
        }
      }

      if (status.status !== 0) {
        resultRecords.push({
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[harness]",
          status: "FAIL",
          message: status.message || "WPT harness reported an error.",
        });
      }

      resolve([...resultRecords, ...skipped]);
    };
    runtime.__wptFailure = (error: Error) => reject(error);
  });

  runtime.__wptSelectTest = (name: string) => {
    if (!target.subtests?.length) {
      selectedNames.add(name);
      return true;
    }

    if (selected.has(name)) {
      selectedNames.add(name);
      return true;
    }

    skipped.push({
      file: target.file,
      variant: target.variant ?? "",
      subtest: name,
      status: "SKIP",
      message: "Not selected in packages/webrtc/wpt/allowlist.json",
    });
    return false;
  };

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
  return results.reduce(
    (summary, result) => {
      switch (result.status) {
        case "PASS":
          summary.passed += 1;
          break;
        case "FAIL":
          summary.failed += 1;
          break;
        case "TIMEOUT":
          summary.timedOut += 1;
          break;
        case "SKIP":
          summary.skipped += 1;
          break;
      }
      return summary;
    },
    { passed: 0, failed: 0, timedOut: 0, skipped: 0 },
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function printTargetList(allowlist: WptAllowlistFile) {
  for (const target of allowlist.targets) {
    const prefix = target.enabled ? "[run]" : "[skip]";
    const variant = target.variant ? ` ${target.variant}` : "";
    console.log(`${prefix} ${target.file}${variant}`);
    console.log(`  reason: ${target.reason}`);
    if (target.subtests?.length) {
      for (const subtest of target.subtests) {
        console.log(`  - ${subtest}`);
      }
    }
  }
}
