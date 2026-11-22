/**
 * Standalone `werift-dtls` interoperability with develop over UDP: a
 * DtlsClient of one revision against a DtlsServer of the other, with the
 * defaults and with this branch's opt-ins. See `harness.ts`.
 */
import { setTimeout } from "node:timers/promises";

import {
  certPem,
  ecdsaP256CertPem,
  ecdsaP256KeyPem,
  keyPem,
} from "../../../../dtls/tests/fixture";
import {
  interopDisabled,
  loadDtls,
  type Side,
  waitUntil,
  withTimeout,
} from "./harness";

type Loaded = Awaited<ReturnType<typeof loadDtls>>;

const sides: Side[] = ["develop", "warp"];
const roles = sides.flatMap((client) =>
  sides.map(
    (server) =>
      [`${client} client x ${server} server`, client, server] as const,
  ),
);

const credentials = {
  rsa: { cert: certPem, key: keyPem, signature: 1 },
  ecdsa: { cert: ecdsaP256CertPem, key: ecdsaP256KeyPem, signature: 3 },
} as const;

describe.skipIf(interopDisabled)(
  "werift-dtls interop with develop",
  { timeout: 30_000 },
  () => {
    const loaded = {} as Record<Side, Loaded>;
    beforeAll(async () => {
      for (const side of sides) loaded[side] = await loadDtls(side);
    });

    /** Shared Arrange: one client/server pair over loopback UDP. */
    async function createPair(
      clientSide: Side,
      serverSide: Side,
      options: {
        credential?: keyof typeof credentials;
        client?: Record<string, unknown>;
        server?: Record<string, unknown>;
      } = {},
    ) {
      const { cert, key, signature } = credentials[options.credential ?? "rsa"];
      const signatureHash = { hash: 4, signature };
      const serverTransport = await loaded[serverSide].common.UdpTransport.init(
        "udp4",
        { interfaceAddresses: { udp4: "127.0.0.1" } } as never,
      );
      const clientTransport = await loaded[clientSide].common.UdpTransport.init(
        "udp4",
        { interfaceAddresses: { udp4: "127.0.0.1" } } as never,
      );
      clientTransport.rinfo = {
        address: "127.0.0.1",
        port: serverTransport.socket.address().port,
      };
      const common = {
        cert,
        key,
        signatureHash,
        srtpProfiles: [7, 1],
        extendedMasterSecret: true,
      };
      const server = new loaded[serverSide].dtls.DtlsServer({
        ...common,
        transport: serverTransport,
        certificateRequest: true,
        ...options.server,
      } as never);
      const client = new loaded[clientSide].dtls.DtlsClient({
        ...common,
        transport: clientTransport,
        ...options.client,
      } as never);
      const events = {
        clientConnect: 0,
        serverConnect: 0,
        serverClose: 0,
        clientClose: 0,
      };
      client.onConnect.subscribe(() => events.clientConnect++);
      server.onConnect.subscribe(() => events.serverConnect++);
      client.onClose.subscribe(() => events.clientClose++);
      server.onClose.subscribe(() => events.serverClose++);
      const dispose = async () => {
        await Promise.allSettled([client.close(), server.close()]);
        await Promise.allSettled([
          clientTransport.close(),
          serverTransport.close(),
        ]);
      };
      return { client, server, events, dispose };
    }

    async function handshake(pair: Awaited<ReturnType<typeof createPair>>) {
      const errors: Error[] = [];
      pair.client.onError.subscribe((e: Error) => errors.push(e));
      pair.server.onError.subscribe((e: Error) => errors.push(e));
      const connected = Promise.all([
        pair.client.onConnect.asPromise(),
        pair.server.onConnect.asPromise(),
      ]);
      pair.client.connect().catch((e: Error) => errors.push(e));
      await withTimeout(
        connected,
        15_000,
        `handshake (${errors.map(String).join()})`,
      );
      return errors;
    }

    async function exchange(pair: Awaited<ReturnType<typeof createPair>>) {
      const atServer: string[] = [];
      const atClient: string[] = [];
      pair.server.onData.subscribe((d: Buffer) => atServer.push(d.toString()));
      pair.client.onData.subscribe((d: Buffer) => atClient.push(d.toString()));
      const big = "y".repeat(1100);
      await pair.client.send(Buffer.from("to-server"));
      await pair.client.send(Buffer.from(big));
      await pair.server.send(Buffer.from("to-client"));
      await waitUntil(
        () => atServer.length === 2 && atClient.length === 1,
        5_000,
        "application data",
      );
      return { atServer, atClient, big };
    }

    describe.each(roles)("%s", (_label, clientSide, serverSide) => {
      test.each(["rsa", "ecdsa"] as const)(
        "default options (%s): handshake, data, SRTP profile",
        async (credential) => {
          const pair = await createPair(clientSide, serverSide, { credential });
          try {
            // Act: 既定オプションのまま handshake してデータを往復させる
            const errors = await handshake(pair);
            const { atServer, atClient, big } = await exchange(pair);
            // Assert: エラーなく接続し、データと SRTP profile が一致する
            expect(errors).toEqual([]);
            expect(atServer).toEqual(["to-server", big]);
            expect(atClient).toEqual(["to-client"]);
            expect(pair.client.srtp.srtpProfile).toBe(
              pair.server.srtp.srtpProfile,
            );
            const clientKeys = pair.client.extractSessionKeys(16, 12);
            const serverKeys = pair.server.extractSessionKeys(16, 12);
            expect(clientKeys.localKey).toEqual(serverKeys.remoteKey);
            expect(clientKeys.remoteKey).toEqual(serverKeys.localKey);
            expect(pair.events).toMatchObject({
              clientConnect: 1,
              serverConnect: 1,
            });
          } finally {
            await pair.dispose();
          }
        },
      );

      test("client close({ notify: true }): the server observes close_notify", async () => {
        const pair = await createPair(clientSide, serverSide);
        try {
          await handshake(pair);
          // Act: client だけ close する
          await pair.client.close({ notify: true });
          // Assert: server は close_notify を受けて onClose を 1 回だけ通知する
          await waitUntil(
            () => pair.events.serverClose > 0,
            5_000,
            "server onClose",
          );
          await setTimeout(200);
          expect(pair.events.serverClose).toBe(1);
        } finally {
          await pair.dispose();
        }
      });

      test("server close({ notify: true }): the client observes close_notify", async () => {
        const pair = await createPair(clientSide, serverSide);
        try {
          await handshake(pair);
          // Act: server だけ close する
          await pair.server.close({ notify: true });
          // Assert: client は close_notify を受けて onClose を 1 回だけ通知する
          await waitUntil(
            () => pair.events.clientClose > 0,
            5_000,
            "client onClose",
          );
          await setTimeout(200);
          expect(pair.events.clientClose).toBe(1);
        } finally {
          await pair.dispose();
        }
      });
    });

    const warpOptIns: [string, Record<string, unknown>][] = [
      ["protocolVersions [1.3, 1.2]", { protocolVersions: ["1.3", "1.2"] }],
      ["handshakeValidation: standard", { handshakeValidation: "standard" }],
      [
        "peerIdentityMode: datagram-address",
        { peerIdentityMode: "datagram-address" },
      ],
    ];
    describe.each(warpOptIns)("warp opt-in %s", (_name, optIn) => {
      test.each([
        ["warp client x develop server", "warp", "develop"],
        ["develop client x warp server", "develop", "warp"],
      ] as const)(
        "%s: connects with DTLS 1.2",
        async (_label, clientSide, serverSide) => {
          const pair = await createPair(clientSide, serverSide, {
            client: clientSide === "warp" ? optIn : {},
            server: serverSide === "warp" ? optIn : {},
          });
          try {
            // Act: warp 側だけ opt-in して develop と handshake する
            const errors = await handshake(pair);
            const { atServer, atClient, big } = await exchange(pair);
            // Assert: develop が話せる DTLS 1.2（develop は 1.2 のみ）で接続し、データが往復する
            expect(errors).toEqual([]);
            expect(atServer).toEqual(["to-server", big]);
            expect(atClient).toEqual(["to-client"]);
          } finally {
            await pair.dispose();
          }
        },
      );
    });
  },
);
