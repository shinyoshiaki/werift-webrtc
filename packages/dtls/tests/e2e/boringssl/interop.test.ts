import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UdpTransport } from "../../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../../src";
import { certPem, keyPem } from "../../fixture";
import {
  BORINGSSL_PIN_REVISION,
  readBuiltRevision,
  resolveBsslPath,
} from "./helpers";

/** Persist flight/alert diagnostics for failed interop runs (CI artifacts). */
const INTEROP_LOG_DIR = join(tmpdir(), `werift-bssl-logs-${process.pid}`);
function interopLog(name: string, body: string) {
  try {
    mkdirSync(INTEROP_LOG_DIR, { recursive: true });
    const path = join(INTEROP_LOG_DIR, `${name}.log`);
    appendFileSync(path, body + "\n");
    console.info(`[boringssl] log written: ${path}`);
  } catch (e) {
    console.error("[boringssl] failed to write log", e);
  }
}

/**
 * Native harness path (preferred). Built via ./build-bssl-echo.sh / fetch-and-build-boringssl.sh.
 * Override: WERIFT_BORINGSSL_DTLS_ECHO
 */
function resolveEchoPath(): string | undefined {
  if (process.env.WERIFT_BORINGSSL_DTLS_ECHO) {
    return process.env.WERIFT_BORINGSSL_DTLS_ECHO;
  }
  const local = join(__dirname, "dtls13_echo");
  if (existsSync(local)) return local;
  return undefined;
}

const echoPath = resolveEchoPath();
const bsslPath = resolveBsslPath();
const hasHarness = !!echoPath;
/**
 * Require harness only when explicitly opted in (dedicated CI job sets this).
 * Do NOT key off CI=true — the main `build` job runs npm test without the
 * BoringSSL pin build; only `dtls13-boringssl` must enforce interop.
 */
const requireHarness = process.env.WERIFT_REQUIRE_BORINGSSL === "1";
const describeBssl = hasHarness
  ? describe
  : requireHarness
    ? describe
    : describe.skip;

function spawnEcho(args: string[]): ChildProcessWithoutNullStreams {
  if (!echoPath) {
    throw new Error(
      "dtls13_echo missing; run fetch-and-build-boringssl.sh or set WERIFT_BORINGSSL_DTLS_ECHO",
    );
  }
  return spawn(echoPath, args, { stdio: ["pipe", "pipe", "pipe"] });
}

function writeCerts() {
  const dir = join(tmpdir(), `werift-bssl-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  return { dir, certPath, keyPath };
}

describe("e2e/boringssl harness gate", () => {
  test("CI requires dtls13_echo harness (P0 interop)", () => {
    // Arrange: 前提を準備する
    if (requireHarness) {
      expect(
        hasHarness,
        "CI must build packages/dtls/tests/e2e/boringssl/dtls13_echo via fetch-and-build-boringssl.sh",
      ).toBe(true);
    } else if (!hasHarness) {
      console.info(
        "[boringssl] skipped: run fetch-and-build-boringssl.sh; " +
          "set WERIFT_REQUIRE_BORINGSSL=1 only in the dedicated CI job",
      );
    }
    expect(BORINGSSL_PIN_REVISION.length).toBeGreaterThan(8);
  });

  test("built revision matches pin when .built-revision present", () => {
    // Arrange: 前提を準備する
    const built = readBuiltRevision();
    // Act / Assert: pin ビルド後は revision 一致を強制
    if (built) {
      expect(built.startsWith(BORINGSSL_PIN_REVISION.slice(0, 12))).toBe(true);
    } else if (requireHarness) {
      // CI で pin スクリプト経由なら .built-revision が必須
      if (process.env.WERIFT_BORINGSSL_ENFORCE_PIN === "1") {
        expect(
          built,
          "run fetch-and-build-boringssl.sh to record pin",
        ).toBeTruthy();
      }
    }
  });
});

describeBssl("e2e/boringssl DTLS 1.3 interop", () => {
  test("documents pinned revision and harness", () => {
    // Arrange: 前提を準備する
    expect(BORINGSSL_PIN_REVISION.length).toBeGreaterThan(8);
    expect(echoPath && existsSync(echoPath)).toBe(true);
  });

  test("werift client connects to BoringSSL DTLS 1.3 server with bidirectional data", async () => {
    // Arrange: 前提を準備する
    const { certPath, keyPath } = writeCerts();
    const port = 45000 + Math.floor(Math.random() * 1000);

    const serverProc = spawnEcho(["server", String(port), certPath, keyPath]);
    let stderr = "";
    serverProc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    await new Promise((r) => setTimeout(r, 200));

    const transport = await UdpTransport.init("udp4");
    transport.rinfo = { address: "127.0.0.1", port };

    const client = new DtlsClient({
      transport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    try {
      // Act: ハンドシェイクを検証する
      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(() => {
          const msg = `BoringSSL server interop timeout\nstderr=${stderr}`;
          interopLog("werift-client-bssl-server-timeout", msg);
          reject(new Error(msg));
        }, 15_000);
        client.onConnect.subscribe(() => {
          clearTimeout(timer);
          resolve();
        });
        client.onError.subscribe((e) => {
          clearTimeout(timer);
          const msg = `${e.message}\nstderr=${stderr}`;
          interopLog("werift-client-bssl-server-error", msg);
          reject(new Error(msg));
        });
        try {
          await client.connect();
        } catch (e) {
          clearTimeout(timer);
          interopLog(
            "werift-client-bssl-server-connect",
            String(e) + "\n" + stderr,
          );
          reject(e);
        }
      });

      // Assert: 双方向データ（echo）
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const msg = `data exchange timeout\nstderr=${stderr}`;
          interopLog("werift-client-bssl-server-data", msg);
          reject(new Error(msg));
        }, 5_000);
        client.onData.subscribe((data) => {
          expect(data.toString()).toBe("hello-bssl");
          clearTimeout(timer);
          resolve();
        });
        void client.send(Buffer.from("hello-bssl"));
      });
      interopLog(
        "werift-client-bssl-server-ok",
        `handshake+bidirectional data ok\nstderr=${stderr}`,
      );
    } finally {
      client.close();
      serverProc.kill("SIGTERM");
    }
  }, 25_000);

  test("BoringSSL client → werift server: must receive client data and echo response", async () => {
    // Arrange: 前提を準備する
    const { certPath, keyPath } = writeCerts();
    const serverTransport = await UdpTransport.init("udp4");
    const port = serverTransport.address.port;

    const server = new DtlsServer({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
    });

    let gotData = "";
    let dataResolve: (() => void) | undefined;
    const dataPromise = new Promise<void>((resolve) => {
      dataResolve = resolve;
    });
    server.onData.subscribe((d) => {
      gotData = d.toString();
      void server.send(d); // echo
      dataResolve?.();
    });

    const clientProc = spawnEcho([
      "client",
      "127.0.0.1",
      String(port),
      certPath,
      keyPath,
    ]);
    let stderr = "";
    let stdout = "";
    clientProc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    clientProc.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    try {
      // Act: 相互接続を検証する
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const msg = `BoringSSL client interop timeout\nstderr=${stderr}\nstdout=${stdout}`;
          interopLog("bssl-client-werift-server-timeout", msg);
          reject(new Error(msg));
        }, 15_000);
        server.onConnect.subscribe(() => {
          clearTimeout(timer);
          resolve();
        });
        server.onError.subscribe((e) => {
          clearTimeout(timer);
          const msg = `${e.message}\nstderr=${stderr}\nstdout=${stdout}`;
          interopLog("bssl-client-werift-server-error", msg);
          reject(new Error(msg));
        });
        clientProc.on("exit", (code) => {
          if (code !== 0 && code !== null) {
            clearTimeout(timer);
            const msg = `bssl client exit ${code}\nstderr=${stderr}\nstdout=${stdout}`;
            interopLog("bssl-client-werift-server-exit", msg);
            reject(new Error(msg));
          }
        });
      });

      // Assert: サーバが client 送信データを必ず受信
      await Promise.race([
        dataPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => {
            const msg = `server did not receive client app data\nstderr=${stderr}\nstdout=${stdout}`;
            interopLog("bssl-client-werift-server-no-data", msg);
            reject(new Error(msg));
          }, 5_000),
        ),
      ]);
      expect(gotData).toContain("hello-from-bssl");

      // Assert: client が echo を受信（stdout に出力）
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const tick = () => {
          if (stdout.includes("hello-from-bssl")) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            const msg = `client did not print echo response\nstdout=${stdout}\nstderr=${stderr}`;
            interopLog("bssl-client-werift-server-no-echo", msg);
            reject(new Error(msg));
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });
      // Peer may send close_notify after app data; association teardown sets
      // connected=false intentionally (public lifecycle parity with local close).
      expect(gotData).toContain("hello-from-bssl");
      interopLog(
        "bssl-client-werift-server-ok",
        `handshake+bidirectional data ok gotData=${gotData}\nstdout=${stdout}\nstderr=${stderr}`,
      );
    } finally {
      clientProc.kill("SIGTERM");
      server.close();
    }
  }, 30_000);
});

if (!hasHarness && !requireHarness) {
  test("boringssl harness skipped (build tests/e2e/boringssl/dtls13_echo)", () => {
    // Arrange: 前提を準備する
    console.info(
      "[boringssl] skipped: run fetch-and-build-boringssl.sh " +
        `(pin ${BORINGSSL_PIN_REVISION}). bssl tool present=${!!bsslPath}`,
    );
    expect(hasHarness).toBe(false);
  });
}
