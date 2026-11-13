import { type ChildProcess, spawn } from "child_process";
import * as os from "os";
import { dirname, resolve } from "path";
import vm from "vm";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";

import { RTCPeerConnection } from "../../src";
import { withBrowserCompatibleConfig } from "./browserConfig";
import { installDocumentWithIframe, installMessageWindow } from "./frameShim";
import { createDummyRegister, installPolyfill } from "../../src/polyfill";
import {
  findBaselineRegressions,
  replaceTargetResults,
  selectStableBaseline,
  selectTimeoutRetryTargets,
  targetKeyOf,
} from "./baselineLogic";
import { resolveTargetConcurrency } from "./concurrencyLogic";
import { ensureWptCheckout } from "./submodule";
import { resolveTimeoutProfile } from "./timeoutLogic";

export interface WptAllowlistFile {
  targets: WptTarget[];
}

export interface WptTarget {
  file: string;
  enabled: boolean;
  reason: string;
  variant?: string;
  /** The subtests this target gates (documentation; the gate is `wpt/baseline.json`). */
  subtests?: string[];
  /**
   * Subtests kept out of the baseline even when they pass in every run
   * (e.g. a known race tracked by another ticket); see `selectStableBaseline`.
   */
  baselineExclusions?: string[];
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
  /**
   * Targets rerun once because every regression of their first run was a
   * timeout (see `selectTimeoutRetryTargets`); `results` / `regressions`
   * hold the rerun.
   */
  retried?: { file: string; variant: string; firstRegressions: number }[];
}

export interface WptProgressEvent {
  type: "start" | "finish";
  target: Pick<WptTarget, "file" | "variant">;
  completed: number;
  running: number;
  targetSummary?: WptRunReport["summary"];
  total: number;
}

const packageDir = process.cwd();
const repoRoot = resolve(packageDir, "..", "..");
const wptRoot = resolve(repoRoot, "third_party", "wpt");
const allowlistPath = resolve(packageDir, "wpt", "allowlist.json");
const baselinePath = resolve(packageDir, "wpt", "baseline.json");
export const defaultReportPath = resolve(
  repoRoot,
  "coverage",
  "webrtc-wpt",
  "results.json",
);
export const defaultMarkdownReportPath = resolve(
  repoRoot,
  "coverage",
  "webrtc-wpt",
  "results.md",
);
const workerPath = resolve(packageDir, "tools", "wpt-runner", "worker.ts");
const registerHookPath = resolve(repoRoot, "tools/node-ts/register.mjs");
const WORKER_RESULT_PREFIX = "__WPT_WORKER_RESULT__:";
const USE_WORKERS = process.env.WPT_USE_WORKERS !== "0";
const PROGRESS_MODE = process.env.WPT_PROGRESS;
const VERBOSE_PROGRESS = PROGRESS_MODE === "verbose";
const TARGET_FILTER = process.env.WPT_TARGET_FILTER;
/** Timeout multiplier of a rerun after a timeout-only regression. */
const RETRY_TIMEOUT_SCALE = 4;
const TIMEOUT_SCALE = Number(process.env.WPT_TIMEOUT_SCALE) || 1;

const IGNORE_SCRIPT_PATHS = new Set([
  "/resources/testharnessreport.js",
  "/resources/testdriver.js",
  "/resources/testdriver-vendor.js",
  "../mediacapture-streams/permission-helper.js",
]);
const ACTIVE_WORKERS = new Set<ChildProcess>();

if (
  !(globalThis as { __weriftWptUnhandledRejectionHook?: boolean })
    .__weriftWptUnhandledRejectionHook
) {
  process.on("unhandledRejection", () => undefined);
  (
    globalThis as { __weriftWptUnhandledRejectionHook?: boolean }
  ).__weriftWptUnhandledRejectionHook = true;
}

export async function loadAllowlist() {
  return JSON.parse(await readFile(allowlistPath, "utf8")) as WptAllowlistFile;
}

export async function discoverWptTargets() {
  await ensureWptCheckout(repoRoot, wptRoot);
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

export async function runSelectedWpt(
  options: {
    compareWithBaseline?: boolean;
    onProgress?: (event: WptProgressEvent) => void;
    reportPath?: string;
    updateBaseline?: boolean;
  } = {},
): Promise<WptRunReport> {
  const targets = await discoverWptTargets();
  let results = await runTargets(targets, options.onProgress);

  let regressions =
    options.compareWithBaseline === false ? [] : await findRegressions(results);

  // 時間切れだけで回帰したターゲットは、負荷による揺れか確かめるため 1 回だけ
  // 逐次・長いタイムアウトで再実行する。FAIL を含む回帰は再実行しない。
  const retryKeys = selectTimeoutRetryTargets(regressions);
  let retried: WptRunReport["retried"];
  if (retryKeys.size > 0) {
    const retryTargets = targets.filter((target) =>
      retryKeys.has(targetKeyOf(target)),
    );
    retried = retryTargets.map((target) => ({
      file: target.file,
      variant: target.variant ?? "",
      firstRegressions: regressions.filter(
        (result) => targetKeyOf(result) === targetKeyOf(target),
      ).length,
    }));
    const rerun = await runTargets(retryTargets, options.onProgress, {
      concurrency: 1,
      timeoutScale: RETRY_TIMEOUT_SCALE,
    });
    results = replaceTargetResults(results, rerun, retryKeys);
    regressions = await findRegressions(results);
  }

  const report: WptRunReport = {
    generatedAt: new Date().toISOString(),
    summary: summarize(results),
    results,
    regressions,
    ...(retried ? { retried } : {}),
  };

  await mkdir(dirname(options.reportPath ?? defaultReportPath), {
    recursive: true,
  });
  await writeFile(
    options.reportPath ?? defaultReportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (options.updateBaseline) {
    await updateBaseline(results);
  }

  return report;
}

async function runTargets(
  targets: WptTarget[],
  onProgress?: (event: WptProgressEvent) => void,
  options: { concurrency?: number; timeoutScale?: number } = {},
) {
  const results: WptResultRecord[] = [];
  const executing = new Set<Promise<void>>();
  const availableParallelism =
    "availableParallelism" in os ? os.availableParallelism() : undefined;
  const targetConcurrency =
    options.concurrency ??
    resolveTargetConcurrency({
      availableParallelism,
      cpuCount: os.cpus().length,
      input: process.env.WPT_CONCURRENCY,
    });
  let completed = 0;

  for (const target of targets) {
    onProgress?.({
      type: "start",
      target,
      completed,
      running: executing.size + 1,
      total: targets.length,
    });

    const executeTarget = USE_WORKERS
      ? runTargetInWorker(target, options.timeoutScale)
      : runTargetInCurrentProcess(target, options.timeoutScale);
    const task = executeTarget.then((targetResults) => {
      results.push(...targetResults);
      completed += 1;
      onProgress?.({
        type: "finish",
        target,
        completed,
        running: Math.max(0, executing.size - 1),
        targetSummary: summarize(targetResults),
        total: targets.length,
      });
      if (
        PROGRESS_MODE &&
        (completed % 10 === 0 || completed === targets.length)
      ) {
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

export async function runTargetInCurrentProcess(
  target: WptTarget,
  timeoutScale = TIMEOUT_SCALE,
): Promise<WptResultRecord[]> {
  if (VERBOSE_PROGRESS) {
    console.error(
      `[wpt] start ${target.file}${target.variant ? ` ${target.variant}` : ""}`,
    );
  }
  const timeoutProfile = resolveTimeoutProfile(target, timeoutScale);
  const htmlPath = resolve(wptRoot, target.file);
  const html = await readFile(htmlPath, "utf8");
  const title = extractTitle(html);
  const { context, enableFrames, mediaDevices, closePeerConnections } =
    createContext({
      cleanupTimeoutMs: timeoutProfile.cleanupTimeoutMs,
      file: target.file,
      variant: target.variant ?? "",
      title,
      withFrames: html.includes("perfect-negotiation-helper.js"),
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
          enableFrames();
        }
        continue;
      }

      vm.runInContext(script.content, context, {
        filename: htmlPath,
        timeout: timeoutProfile.vmTimeoutMs,
      });
    }
    if (VERBOSE_PROGRESS) {
      console.error(
        `[wpt] waiting ${target.file}${target.variant ? ` ${target.variant}` : ""}`,
      );
    }

    const outcome = await withTimeout<WptResultRecord[] | undefined>(
      completion.done,
      timeoutProfile.completionTimeoutMs,
      undefined,
    );
    if (outcome) return outcome;
    // ファイル全体が時間切れでも、それまでに終わった subtest の結果は残す
    // (残さないと baseline の subtest が報告されず、回帰を検出できない)
    return [
      ...completion.finished(),
      {
        file: target.file,
        variant: target.variant ?? "",
        subtest: "[timeout]",
        status: "TIMEOUT",
        message: `WPT file did not finish before the runner timeout (${timeoutProfile.completionTimeoutMs}ms).`,
      },
    ];
  } catch (error) {
    return [
      {
        file: target.file,
        variant: target.variant ?? "",
        subtest: "[exception]",
        status: "FAIL",
        message:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      },
    ];
  } finally {
    if (VERBOSE_PROGRESS) {
      console.error(
        `[wpt] cleanup ${target.file}${target.variant ? ` ${target.variant}` : ""}`,
      );
    }
    await closePeerConnections();
    mediaDevices.cleanup();
    if (VERBOSE_PROGRESS) {
      console.error(
        `[wpt] finish ${target.file}${target.variant ? ` ${target.variant}` : ""}`,
      );
    }
  }
}

async function runTargetInWorker(
  target: WptTarget,
  timeoutScale = TIMEOUT_SCALE,
): Promise<WptResultRecord[]> {
  const timeoutMs = resolveWorkerTimeoutMs(
    resolveTimeoutProfile(target, timeoutScale),
  );

  return await new Promise<WptResultRecord[]>((resolveResult) => {
    const worker = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        registerHookPath,
        workerPath,
      ],
      {
        cwd: packageDir,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          WPT_PROGRESS: "",
          WPT_TARGET_JSON: JSON.stringify(target),
          WPT_TIMEOUT_SCALE: String(timeoutScale),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    ACTIVE_WORKERS.add(worker);
    let finished = false;
    let forcedResult: WptResultRecord[] | undefined;
    let forceFinishTimer: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      forcedResult = [
        {
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[worker-timeout]",
          status: "TIMEOUT",
          message: `WPT worker exceeded ${timeoutMs}ms and was terminated.`,
        },
      ];
      terminateWorker(worker, "SIGKILL");
      forceFinishTimer = setTimeout(() => {
        finish(forcedResult ?? []);
      }, 500);
    }, timeoutMs);

    const finish = (workerResults: WptResultRecord[]) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      if (forceFinishTimer) {
        clearTimeout(forceFinishTimer);
      }
      ACTIVE_WORKERS.delete(worker);
      worker.stdout?.removeAllListeners();
      worker.stderr?.removeAllListeners();
      worker.removeAllListeners();
      worker.stdout?.destroy();
      worker.stderr?.destroy();
      resolveResult(workerResults);
    };

    worker.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    worker.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    worker.on("error", (error) => {
      finish([
        {
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[worker-error]",
          status: "FAIL",
          message: error.stack ?? error.message,
        },
      ]);
    });
    worker.on("close", (code, signal) => {
      if (forcedResult) {
        finish(forcedResult);
        return;
      }
      const workerResults = extractWorkerResults(stdout);
      if (workerResults) {
        finish(workerResults);
        return;
      }

      finish([
        {
          file: target.file,
          variant: target.variant ?? "",
          subtest: "[worker-exit]",
          status: "FAIL",
          message: [
            `WPT worker exited before returning results (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ]);
    });
  });
}

function createContext(input: {
  cleanupTimeoutMs: number;
  file: string;
  variant: string;
  title: string;
  frame?: { parent: Record<string, any> };
  withFrames?: boolean;
}) {
  const peerConnections = new Set<RTCPeerConnection>();
  const location = new URL(`https://wpt.local/${input.file}${input.variant}`);
  const sandbox: Record<string, unknown> = {
    AbortController,
    Buffer,
    DOMException,
    Error,
    Event,
    EventTarget,
    HTMLCanvasElement: class HTMLCanvasElement {},
    META_TITLE: input.title,
    MediaStreamAudioDestinationNode: undefined,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
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
  sandbox.parent = input.frame?.parent ?? sandbox;
  sandbox.top = input.frame?.parent ?? sandbox;

  installPolyfill({
    target: sandbox,
    mediaRegister: [createDummyRegister()],
    existingMediaDevices: "overwrite",
  });

  const WptRTCPeerConnection = createPeerConnectionWrapper(peerConnections);
  sandbox.RTCPeerConnection = WptRTCPeerConnection;

  const childClosers = new Set<() => Promise<void>>();
  const context = vm.createContext(sandbox);
  // testharness.js は document / addEventListener の有無で環境を判定するので、
  // 読み込み後（enableFrames）にだけ window 間通信と iframe を用意する
  const enableFrames = () => {
    if (!input.withFrames) {
      return;
    }
    installMessageWindow(sandbox, { postMessageTarget: () => sandbox });
    installDocumentWithIframe({
      top: sandbox,
      extractScripts,
      createChild: () => {
        const child = createContext({
          ...input,
          withFrames: false,
          frame: { parent: sandbox },
        });
        return {
          window: child.context as unknown as Record<string, any>,
          context: child.context,
          close: child.closePeerConnections,
        };
      },
      onChildClose: (close) => childClosers.add(close),
    });
  };
  if (input.frame) {
    installMessageWindow(sandbox, { postMessageTarget: () => sandbox });
  }

  return {
    context,
    enableFrames,
    mediaDevices: (sandbox.navigator as { mediaDevices: { cleanup(): void } })
      .mediaDevices,
    closePeerConnections: async () => {
      await Promise.allSettled([...childClosers].map((close) => close()));
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

function createPeerConnectionWrapper(peerConnections: Set<RTCPeerConnection>) {
  class WptRTCPeerConnection extends RTCPeerConnection {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      // upstream WPT はブラウザの挙動を前提にするので、werift の既定ではなく
      // ブラウザ互換の構築時設定 (BROWSER_COMPATIBLE_PEER_CONFIG) で試験する。
      const [config, ...rest] = args;
      super(
        withBrowserCompatibleConfig(config) as ConstructorParameters<
          typeof RTCPeerConnection
        >[0],
        ...rest,
      );
      peerConnections.add(this);
      const setLocalDescription = this.setLocalDescription.bind(this);
      this.setLocalDescription = ((
        ...sldArgs: Parameters<RTCPeerConnection["setLocalDescription"]>
      ) =>
        this.holdIceCandidatesDuring(() =>
          setLocalDescription(...sldArgs),
        )) as RTCPeerConnection["setLocalDescription"];
    }

    // ブラウザの operations chain と同じく、処理中の setRemoteDescription() の完了を待ってから
    // addIceCandidate() を評価する（perfect negotiation の helper は candidate を description の直後に投げる）
    private pendingSetRemoteDescription: Promise<unknown> | undefined;

    override setRemoteDescription(
      ...args: Parameters<RTCPeerConnection["setRemoteDescription"]>
    ) {
      const promise = super.setRemoteDescription(...args);
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      this.pendingSetRemoteDescription = settled;
      void settled.then(() => {
        if (this.pendingSetRemoteDescription === settled) {
          this.pendingSetRemoteDescription = undefined;
        }
      });
      return promise;
    }

    override async addIceCandidate(
      ...args: Parameters<RTCPeerConnection["addIceCandidate"]>
    ) {
      await this.pendingSetRemoteDescription;
      if (!this.remoteDescription) {
        const promise = Promise.reject(
          new DOMException(
            "The remote description was null",
            "InvalidStateError",
          ),
        );
        promise.catch(() => undefined);
        return promise;
      }
      const promise = super.addIceCandidate(...args);
      promise.catch(() => undefined);
      return promise;
    }

    // ブラウザでは icecandidate は setLocalDescription() の解決後に発火する。
    // werift は解決前に発火するため、upstream WPT（perfect negotiation の helper）が
    // 前提にする順序（description → candidate）に合わせて、WPT 実行時だけ解決後まで遅らせる。
    private heldIceCandidateCalls: (() => void)[] | undefined;
    private holdingIceCandidates = 0;

    private holdIceCandidatesDuring<T>(operation: () => Promise<T>) {
      this.holdingIceCandidates++;
      return operation().finally(() => {
        setTimeout(() => {
          this.holdingIceCandidates--;
          if (this.holdingIceCandidates === 0) {
            const calls = this.heldIceCandidateCalls ?? [];
            this.heldIceCandidateCalls = undefined;
            for (const call of calls) {
              call();
            }
          }
        }, 0);
      });
    }

    override emit(type: string, ...args: any[]) {
      if (type === "icecandidate" && this.holdingIceCandidates > 0) {
        (this.heldIceCandidateCalls ??= []).push(() =>
          super.emit(type, ...args),
        );
        return true;
      }
      return super.emit(type, ...args);
    }

    override async close() {
      try {
        await super.close();
      } finally {
        peerConnections.delete(this);
      }
    }
  }

  defineHeldEventAttribute(WptRTCPeerConnection.prototype, "onicecandidate");

  for (const eventName of [
    "ondatachannel",
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

/** `emit` と同じく setLocalDescription() の解決後まで handler 呼び出しを遅らせる属性 */
function defineHeldEventAttribute(target: object, name: string) {
  const storageKey = Symbol(name);
  Object.defineProperty(target, name, {
    get(this: Record<PropertyKey, any>) {
      const handler = this[storageKey];
      if (!handler) {
        return null;
      }
      return (...args: unknown[]) => {
        if (this.holdingIceCandidates > 0) {
          (this.heldIceCandidateCalls ??= []).push(() => handler(...args));
          return;
        }
        return handler(...args);
      };
    },
    set(this: Record<PropertyKey, unknown>, value: unknown) {
      this[storageKey] = value ?? undefined;
    },
    configurable: true,
    enumerable: true,
  });
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
  const finished: WptResultRecord[] = [];
  runtime.__wptResult = (test: {
    name: string;
    message: string;
    status: number;
  }) => {
    finished.push({
      file: target.file,
      variant: target.variant ?? "",
      subtest: test.name,
      status: mapStatus(test.status),
      message: test.message || undefined,
    });
  };
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
    /** The subtests that finished so far (for a whole-file timeout). */
    finished: () => [...finished],
  };
}

const harnessPatch = `
  add_result_callback((test) => globalThis.__wptResult(test));
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
  return findBaselineRegressions(baseline.results, results);
}

/** `--update-baseline`: the PASS subtests of this run (see `selectStableBaseline`). */
async function updateBaseline(results: WptResultRecord[]) {
  await writeBaseline(selectStableBaseline([results], await loadAllowlist()));
}

export async function writeBaseline(results: WptResultRecord[]) {
  await writeFile(
    baselinePath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    )}\n`,
  );
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
  const partiallyPassingFiles = summarizeByFile(report.results)
    .filter((file) => file.passed > 0)
    .sort((left, right) => {
      return (
        right.passed - left.passed ||
        left.failed - right.failed ||
        left.timedOut - right.timedOut ||
        left.file.localeCompare(right.file) ||
        left.variant.localeCompare(right.variant)
      );
    });

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

  if (report.retried && report.retried.length > 0) {
    lines.push(
      "",
      "## Rerun after timeout-only regressions",
      "",
      `Rerun once, one at a time with ${RETRY_TIMEOUT_SCALE}x timeouts; the results above are the rerun.`,
      "",
      "| File | First-run regressions |",
      "| --- | ---: |",
      ...report.retried.map(
        (target) =>
          `| ${target.file}${target.variant ? ` ${target.variant}` : ""} | ${target.firstRegressions} |`,
      ),
    );
  }

  if (report.regressions.length > 0) {
    lines.push(
      "",
      "## Regressions",
      "",
      "| File | Subtest | Status | Message |",
      "| --- | --- | --- | --- |",
      ...report.regressions.map(
        (result) =>
          `| ${result.file}${result.variant ? ` ${result.variant}` : ""} | ${escapeTableCell(result.subtest)} | ${result.status} | ${escapeTableCell(result.message ?? "")} |`,
      ),
    );
  }

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

  if (partiallyPassingFiles.length > 0) {
    lines.push(
      "",
      "## Files with at least one passing subtest",
      "",
      "| File | Variant | PASS | FAIL | TIMEOUT |",
      "| --- | --- | ---: | ---: | ---: |",
      ...partiallyPassingFiles.map(
        (file) =>
          `| ${file.file} | ${file.variant || "(default)"} | ${file.passed} | ${file.failed} | ${file.timedOut} |`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

export function formatProgressEvent(event: WptProgressEvent) {
  const variant = event.target.variant ? ` ${event.target.variant}` : "";
  if (event.type === "start") {
    return `[wpt] [${event.completed}/${event.total}] running ${event.target.file}${variant} (${event.running} active)`;
  }

  const summary = event.targetSummary ?? {
    failed: 0,
    passed: 0,
    skipped: 0,
    timedOut: 0,
    total: 0,
  };
  return `[wpt] [${event.completed}/${event.total}] finished ${event.target.file}${variant} (PASS ${summary.passed} / FAIL ${summary.failed} / TIMEOUT ${summary.timedOut}, ${event.running} active)`;
}

export function printTargetList(targets: WptTarget[]) {
  console.log(`# WPT WebRTC targets (${targets.length})`);
  console.log("");
  for (const target of targets) {
    const variant = target.variant ? ` ${target.variant}` : "";
    console.log(`- ${target.file}${variant}`);
  }
}

async function listWptHtmlFiles(
  directoryPath: string,
  parent = "",
): Promise<string[]> {
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
    const entry = byFile.get(key) ?? {
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
) {
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

function resolveWorkerTimeoutMs(
  timeoutProfile: ReturnType<typeof resolveTimeoutProfile>,
) {
  return (
    timeoutProfile.vmTimeoutMs * 4 +
    timeoutProfile.completionTimeoutMs +
    timeoutProfile.cleanupTimeoutMs +
    1_000
  );
}

function extractWorkerResults(stdout: string) {
  const line = stdout
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith(WORKER_RESULT_PREFIX));
  if (!line) {
    return undefined;
  }

  return JSON.parse(
    line.slice(WORKER_RESULT_PREFIX.length),
  ) as WptResultRecord[];
}

export function readTargetFromEnvironment() {
  const raw = process.env.WPT_TARGET_JSON;
  if (!raw) {
    throw new Error("WPT_TARGET_JSON is required for the worker process.");
  }

  return JSON.parse(raw) as WptTarget;
}

export function serializeWorkerResults(results: WptResultRecord[]) {
  return `${WORKER_RESULT_PREFIX}${JSON.stringify(results)}\n`;
}

function terminateWorker(worker: ChildProcess, signal: NodeJS.Signals) {
  if (worker.exitCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32" && worker.pid) {
      process.kill(-worker.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child termination when process groups are unavailable.
  }

  worker.kill(signal);
}

function cleanupActiveWorkers(signal: NodeJS.Signals) {
  for (const worker of ACTIVE_WORKERS) {
    terminateWorker(worker, signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  if (!process.listeners(signal).includes(cleanupActiveWorkers as any)) {
    process.on(signal, () => cleanupActiveWorkers(signal));
  }
}

process.on("exit", () => cleanupActiveWorkers("SIGKILL"));

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
}
