import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

import { TcpTransport, TlsTransport } from "../src/transport";

function generateTestCert(): { key: string; cert: string } | null {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "werift-test-"));
    const keyPath = path.join(tmpDir, "key.pem");
    const certPath = path.join(tmpDir, "cert.pem");

    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);

    const key = fs.readFileSync(keyPath, "utf-8");
    const cert = fs.readFileSync(certPath, "utf-8");

    fs.rmSync(tmpDir, { recursive: true });
    return { key, cert };
  } catch {
    return null;
  }
}

function createTlsEchoServer(
  key: string,
  cert: string,
): Promise<{ server: tls.Server; port: number }> {
  return new Promise((resolve) => {
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on("data", (data) => socket.write(data));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function createTcpEchoServer(): Promise<{
  server: net.Server;
  port: number;
}> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", (data) => socket.write(data));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

const hasOpenssl = generateTestCert() !== null;

describe.skipIf(!hasOpenssl)("TlsTransport", () => {
  let testCert: { key: string; cert: string };

  beforeAll(() => {
    testCert = generateTestCert()!;
  });

  test("connects and exchanges data over TLS", async () => {
    const { server, port } = await createTlsEchoServer(
      testCert.key,
      testCert.cert,
    );

    try {
      const transport = await TlsTransport.init(["127.0.0.1", port], { rejectUnauthorized: false });
      expect(transport.type).toBe("tls");
      expect(transport.closed).toBe(false);

      const received = new Promise<Buffer>((resolve) => {
        transport.onData = (data) => resolve(data);
      });

      await transport.send(Buffer.from("hello-tls"));
      const echo = await received;
      expect(echo.toString()).toBe("hello-tls");

      await transport.close();
      expect(transport.closed).toBe(true);
    } finally {
      server.close();
    }
  });

  test("handles multiple sequential sends", async () => {
    const { server, port } = await createTlsEchoServer(
      testCert.key,
      testCert.cert,
    );

    try {
      const transport = await TlsTransport.init(["127.0.0.1", port], { rejectUnauthorized: false });

      const messages: Buffer[] = [];
      transport.onData = (data) => messages.push(data);

      await transport.send(Buffer.from("msg1"));
      await transport.send(Buffer.from("msg2"));
      await transport.send(Buffer.from("msg3"));

      // Wait briefly for echoes to arrive
      await new Promise((r) => setTimeout(r, 100));

      const combined = Buffer.concat(messages).toString();
      expect(combined).toContain("msg1");
      expect(combined).toContain("msg2");
      expect(combined).toContain("msg3");

      await transport.close();
    } finally {
      server.close();
    }
  });

  test("close sets closed flag", async () => {
    const { server, port } = await createTlsEchoServer(
      testCert.key,
      testCert.cert,
    );

    try {
      const transport = await TlsTransport.init(["127.0.0.1", port], { rejectUnauthorized: false });
      expect(transport.closed).toBe(false);
      await transport.close();
      expect(transport.closed).toBe(true);
    } finally {
      server.close();
    }
  });

  // RFC 7350: TLS certificate must be verified by default
  test("rejects self-signed cert when rejectUnauthorized is not disabled", async () => {
    const { server, port } = await createTlsEchoServer(
      testCert.key,
      testCert.cert,
    );

    try {
      await expect(
        TlsTransport.init(["127.0.0.1", port]),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  // pion gather.go: if TLS handshake fails, connection is closed and candidate abandoned
  test("rejects when connection is refused", async () => {
    // Connect to a port with nothing listening — ECONNREFUSED should reject init
    await expect(
      TlsTransport.init(["127.0.0.1", 1], { rejectUnauthorized: false }),
    ).rejects.toThrow();
  });

  // Verify TLS delivers stream data that may be coalesced (relevant to Bug 1 fix)
  test("handles coalesced stream data", async () => {
    const { server, port } = await createTlsEchoServer(
      testCert.key,
      testCert.cert,
    );

    try {
      const transport = await TlsTransport.init(["127.0.0.1", port], { rejectUnauthorized: false });

      const messages: Buffer[] = [];
      transport.onData = (data) => messages.push(data);

      // Send multiple small messages rapidly — TLS may coalesce them
      const sendPromises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        sendPromises.push(transport.send(Buffer.from(`m${i}`)));
      }
      await Promise.all(sendPromises);

      await new Promise((r) => setTimeout(r, 200));

      const combined = Buffer.concat(messages).toString();
      for (let i = 0; i < 10; i++) {
        expect(combined).toContain(`m${i}`);
      }

      await transport.close();
    } finally {
      server.close();
    }
  });
});

describe("TcpTransport", () => {
  test("connects and exchanges data over TCP", async () => {
    const { server, port } = await createTcpEchoServer();

    try {
      const transport = await TcpTransport.init(["127.0.0.1", port]);
      expect(transport.type).toBe("tcp");

      const received = new Promise<Buffer>((resolve) => {
        transport.onData = (data) => resolve(data);
      });

      await transport.send(Buffer.from("hello-tcp"));
      const echo = await received;
      expect(echo.toString()).toBe("hello-tcp");

      await transport.close();
    } finally {
      server.close();
    }
  });
});
