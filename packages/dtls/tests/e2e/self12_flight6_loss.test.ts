import { ContentType } from "../../src/record/const";
import { connectUdpDtlsPair } from "../fixture";

/**
 * RFC 6347 §4.2.4: Flight6（server の ChangeCipherSpec + Finished）には自前の再送
 * タイマーが無く、失われたら client の Flight5 再送に応えて送り直す。
 */
describe("e2e/self12: Flight6 loss", () => {
  test("server の最初の Flight6 が失われても client の Flight5 再送で handshake が完了し、onConnect は 1 回ずつ", async () => {
    // Arrange: server が最初に送る Flight6 の ChangeCipherSpec / Finished を落とす
    let droppedFlight6 = 0;
    const connects = { server: 0, client: 0 };

    // Act: 接続する（Flight6 の再送が無いと connect timeout で失敗する）
    const { server, client, serverTransport, clientTransport } =
      await connectUdpDtlsPair({
        beforeConnect: ({ server, client, serverTransport }) => {
          server.onConnect.subscribe(() => connects.server++);
          client.onConnect.subscribe(() => connects.client++);
          const send = serverTransport.send.bind(serverTransport);
          let firstFlight6Sent = false;
          serverTransport.send = async (data, addr) => {
            const dtls = (server as any).dtls;
            const isFlight6Record =
              dtls.flight === 6 &&
              (data[0] === ContentType.changeCipherSpec ||
                (data[0] === ContentType.handshake &&
                  data.readUInt16BE(3) === 1));
            if (isFlight6Record && !firstFlight6Sent) {
              droppedFlight6++;
              // CCS と Finished の 2 record を落としたら以後は通す
              if (droppedFlight6 >= 2) firstFlight6Sent = true;
              return;
            }
            return send(data, addr);
          };
        },
      });
    try {
      await new Promise((r) => setTimeout(r, 100));

      // Assert: 最初の Flight6 は落ちたが、両側とも接続し onConnect はちょうど 1 回
      expect(droppedFlight6).toBe(2);
      expect(server.connected).toBe(true);
      expect(client.connected).toBe(true);
      expect(connects).toEqual({ server: 1, client: 1 });
    } finally {
      client.close();
      server.close();
      await clientTransport.close().catch(() => {});
      await serverTransport.close().catch(() => {});
    }
  }, 30_000);
});
