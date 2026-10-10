import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsVersion, EARLY_APP_DATA_UNLIMITED } from "../../src";
import { SessionType } from "../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../src/engine/v1_3/connection";
import { arrangeHeldEarlyServerAppData, certPem, keyPem } from "../fixture";

/**
 * RFC 9147 / TLS 1.3: server may send application data on epoch 3 after its
 * Finished, before receiving client Finished (early server data). Client must
 * buffer or deliver after connect — we buffer then flush on markConnected.
 */
describe("e2e/self13 early server application data", () => {
  test("server app data after server Finished is delivered to client", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const server = new Dtls13Connection(
      {
        transport: serverTransport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
        offeredProtocolVersions: [DtlsVersion.V1_3],
      },
      SessionType.SERVER,
    );
    const client = new Dtls13Connection(
      {
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
        offeredProtocolVersions: [DtlsVersion.V1_3],
      },
      SessionType.CLIENT,
    );

    // Slow client epoch-2 processing so server can emit early app data first
    const clientAny = client as any;
    const origProcess = clientAny.processHandshakeBytes.bind(client);
    let delayed = false;
    clientAny.processHandshakeBytes = async (bytes: Buffer, epoch: number) => {
      if (epoch === 2 && !delayed) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return origProcess(bytes, epoch);
    };

    const earlyPayload = Buffer.from("early-from-server");
    let earlyDelivered = false;

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("early server app data timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });

      client.onData.subscribe((data) => {
        if (data.equals(earlyPayload)) {
          earlyDelivered = true;
        }
      });

      client.onConnect.subscribe(() => {
        // Assert: 暗号ベクトルを検証する
        void (async () => {
          // Allow microtask flush of earlyAppData
          await new Promise((r) => setTimeout(r, 50));
          try {
            expect(earlyDelivered).toBe(true);
            clearTimeout(timer);
            client.close();
            server.close();
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        })();
      });

      // Act: 暗号ベクトルを検証する
      // before client Finished (server not yet connected)
      const sendEarlyWhenReady = async () => {
        for (let i = 0; i < 100; i++) {
          if (server["writeEpoch"] >= 3 && !server.connected) {
            await server.send(earlyPayload);
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("server never reached writeEpoch 3 before connect");
      };

      void sendEarlyWhenReady().catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
      await client.connect();
    });
  }, 20_000);

  test("maxEarlyAppDataRecords option drops overflow before markConnected", async () => {
    // Arrange: 早期バッファを 2 レコードに制限し、markConnected だけ遅らせる
    const pair = await arrangeHeldEarlyServerAppData({
      maxEarlyAppDataRecords: 2,
      maxEarlyAppDataBytes: 64 * 1024,
    });
    const { server, client } = pair;
    expect(client["maxEarlyAppDataRecords"]).toBe(2);
    expect(client["epochs"].get(3)?.readKeys).toBeTruthy();
    expect(client.connected).toBe(false);

    try {
      // Act: 未接続のまま制限を超える早期 app data を送る
      for (let n = 0; n < 4; n++) {
        await server.send(Buffer.from(`early-${n}`));
      }
      await new Promise((r) => setTimeout(r, 50));

      // Assert: 接続前バッファは 2 件で打ち切られる
      expect(client["earlyAppData"].map((b: Buffer) => b.toString())).toEqual([
        "early-0",
        "early-1",
      ]);

      // Act: markConnected を再開して handshake を完了させる
      await pair.release();
      await new Promise((r) => setTimeout(r, 50));

      // Assert: flush 後も超過分は届かず、overflow は handshake を失敗させない
      expect(pair.received).toEqual(["early-0", "early-1"]);
      expect(pair.errors).toEqual([]);
    } finally {
      pair.close();
    }
  }, 20_000);

  test("maxEarlyAppDataBytes option drops the newest record over the byte cap", async () => {
    // Arrange: record 数には余裕があり、byte 上限 (16) だけが効く設定にする
    const pair = await arrangeHeldEarlyServerAppData({
      maxEarlyAppDataRecords: 256,
      maxEarlyAppDataBytes: 16,
    });
    const { server, client } = pair;
    expect(client.connected).toBe(false);

    try {
      // Act: 7 byte の record を 3 件送る (3 件目で 21 > 16 byte になる)
      for (let n = 0; n < 3; n++) {
        await server.send(Buffer.from(`bytes-${n}`));
      }
      await new Promise((r) => setTimeout(r, 50));

      // Assert: 古い 2 件を保持し、byte 上限を超える新しい record だけを落とす
      expect(client["earlyAppData"].map((b: Buffer) => b.toString())).toEqual([
        "bytes-0",
        "bytes-1",
      ]);
      expect(client.earlyDataStats).toMatchObject({
        bufferedBytes: 14,
        droppedPackets: 1,
        droppedBytes: 7,
      });

      // Act: handshake を完了させる
      await pair.release();
      await new Promise((r) => setTimeout(r, 50));

      // Assert: 保持分だけを受信順に配送し、overflow でも接続は成立する
      expect(pair.received).toEqual(["bytes-0", "bytes-1"]);
      expect(pair.errors).toEqual([]);
    } finally {
      pair.close();
    }
  }, 20_000);

  test("2 s retention expiry discards early data without failing the handshake", async () => {
    // Arrange: 既定上限のまま markConnected を遅らせる
    const pair = await arrangeHeldEarlyServerAppData();
    const { server, client } = pair;
    expect(client.connected).toBe(false);

    try {
      // Act: 早期 app data を 2 件送り、retention (2 秒) を超えて待つ
      await server.send(Buffer.from("stale-0"));
      await server.send(Buffer.from("stale-1"));
      await new Promise((r) => setTimeout(r, 50));
      expect(client.earlyDataStats.bufferedPackets).toBe(2);
      // retention 内 (受信から 1.5 秒程度) ではまだ保持している
      await new Promise((r) => setTimeout(r, 1_500));
      expect(client.earlyDataStats.bufferedPackets).toBe(2);
      const deadline = Date.now() + 5_000;
      while (
        client.earlyDataStats.bufferedPackets > 0 &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Assert: queue 全体が期限切れで破棄され、drop として計上される
      expect(client.earlyDataStats).toMatchObject({
        bufferedPackets: 0,
        droppedPackets: 2,
      });

      // Act: handshake を完了させ、期限切れ後の新しい data を送る
      await pair.release();
      await server.send(Buffer.from("fresh"));
      await new Promise((r) => setTimeout(r, 50));

      // Assert: timeout は handshake を失敗させず、期限切れ分は配送しない
      expect(client.connected).toBe(true);
      expect(pair.errors).toEqual([]);
      expect(pair.received).toEqual(["fresh"]);
    } finally {
      pair.close();
    }
  }, 20_000);

  test("EARLY_APP_DATA_UNLIMITED buffers all pre-connect app data", async () => {
    // Arrange: P2P 向け無制限、markConnected だけ遅らせる
    const pair = await arrangeHeldEarlyServerAppData({
      maxEarlyAppDataRecords: EARLY_APP_DATA_UNLIMITED,
      maxEarlyAppDataBytes: EARLY_APP_DATA_UNLIMITED,
    });
    const { server, client } = pair;
    expect(client["maxEarlyAppDataRecords"]).toBe(Number.POSITIVE_INFINITY);
    expect(client.connected).toBe(false);

    try {
      // Act: 既定 256 より少ないが、上限なしで全件保持できることを確認
      for (let n = 0; n < 4; n++) {
        await server.send(Buffer.from(`p2p-${n}`));
      }
      await new Promise((r) => setTimeout(r, 50));

      // Assert: 無制限なので 4 件すべてバッファされる
      expect(client["earlyAppData"].map((b: Buffer) => b.toString())).toEqual([
        "p2p-0",
        "p2p-1",
        "p2p-2",
        "p2p-3",
      ]);

      // Act: handshake を完了させる
      await pair.release();
      await new Promise((r) => setTimeout(r, 50));

      // Assert: 全件が受信順に配送される
      expect(pair.received).toEqual(["p2p-0", "p2p-1", "p2p-2", "p2p-3"]);
    } finally {
      pair.close();
    }
  }, 20_000);
});
