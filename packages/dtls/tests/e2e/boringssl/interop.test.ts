import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { UdpTransport } from "../../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../../src";
import { certPem, keyPem } from "../../fixture";
import { BORINGSSL_PIN_REVISION, resolveBsslPath } from "./helpers";

/**
 * Native harness path (preferred). Built via ./build-bssl-echo.sh against pinned BoringSSL.
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
const describeBssl = hasHarness ? describe : describe.skip;

function spawnEcho(args: string[]): ChildProcessWithoutNullStreams {
  return spawn(echoPath!, args, { stdio: ["pipe", "pipe", "pipe"] });
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

describeBssl("e2e/boringssl DTLS 1.3 interop", () => {
  test("documents pinned revision and harness", () => {
    // Arrange / Assert
    expect(BORINGSSL_PIN_REVISION.length).toBeGreaterThan(8);
    expect(echoPath && existsSync(echoPath)).toBe(true);
  });

  test(
    "werift client connects to BoringSSL DTLS 1.3 server",
    async () => {
      // Arrange
      const { certPath, keyPath } = writeCerts();
      const port = 45000 + Math.floor(Math.random() * 1000);

      const serverProc = spawnEcho(["server", String(port), certPath, keyPath]);
      let stderr = "";
      serverProc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      // サーバ起動待ち
      await new Promise((r) => setTimeout(r, 200));

      const transport = await UdpTransport.init("udp4");
      transport.rinfo = { address: "127.0.0.1", port };

      const client = new DtlsClient({
        transport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
      });

      try {
        // Act
        await new Promise<void>(async (resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `BoringSSL server interop timeout\nstderr=${stderr}`,
              ),
            );
          }, 15_000);
          client.onConnect.subscribe(() => {
            clearTimeout(timer);
            resolve();
          });
          client.onError.subscribe((e) => {
            clearTimeout(timer);
            reject(
              new Error(`${e.message}\nstderr=${stderr}`),
            );
          });
          try {
            await client.connect();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });

        // Assert: 双方向データ
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("data exchange timeout")),
            5_000,
          );
          client.onData.subscribe((data) => {
            expect(data.toString()).toBe("hello-bssl");
            clearTimeout(timer);
            resolve();
          });
          void client.send(Buffer.from("hello-bssl"));
        });
      } finally {
        client.close();
        serverProc.kill("SIGTERM");
      }
    },
    25_000,
  );

  test(
    "BoringSSL DTLS 1.3 client connects to werift server",
    async () => {
      // Arrange
      const { certPath, keyPath } = writeCerts();
      const serverTransport = await UdpTransport.init("udp4");
      const port = serverTransport.address.port;

      const server = new DtlsServer({
        transport: serverTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
      });

      let gotData = "";
      server.onData.subscribe((d) => {
        gotData = d.toString();
        void server.send(d);
      });

      const clientProc = spawnEcho([
        "client",
        "127.0.0.1",
        String(port),
        certPath,
        keyPath,
      ]);
      let stderr = "";
      clientProc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      try {
        // Act
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                `BoringSSL client interop timeout\nstderr=${stderr}`,
              ),
            );
          }, 15_000);
          server.onConnect.subscribe(() => {
            clearTimeout(timer);
            resolve();
          });
          server.onError.subscribe((e) => {
            clearTimeout(timer);
            reject(new Error(`${e.message}\nstderr=${stderr}`));
          });
          clientProc.on("exit", (code) => {
            if (code !== 0 && code !== null) {
              clearTimeout(timer);
              reject(
                new Error(
                  `bssl client exit ${code}\nstderr=${stderr}`,
                ),
              );
            }
          });
        });

        // Assert
        expect(server.connected).toBe(true);
        // client may have already sent data
        await new Promise((r) => setTimeout(r, 500));
        if (gotData) {
          expect(gotData).toContain("hello-from-bssl");
        }
      } finally {
        clientProc.kill("SIGTERM");
        server.close();
      }
    },
    25_000,
  );
});

if (!hasHarness) {
  test("boringssl harness skipped (build tests/e2e/boringssl/dtls13_echo)", () => {
    // Arrange / Act / Assert
    console.info(
      "[boringssl] skipped: run tests/e2e/boringssl/build-bssl-echo.sh " +
        "(requires BoringSSL headers+libs; pin in README.md). " +
        `bssl tool present=${!!bsslPath}`,
    );
    expect(hasHarness).toBe(false);
  });
}
