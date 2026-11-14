import { ContentType } from "../../src";
import {
  connectDtlsPair,
  createDtlsPair,
  type PairedTransport,
  sentRecords,
} from "../utils";

/** epoch ごとの record sequence number 一覧 */
const sequenceNumbersOf = (transport: PairedTransport, epoch: number) =>
  sentRecords(transport.sent)
    .filter((r) => r.epoch === epoch)
    .map((r) => ({
      contentType: r.contentType,
      sequenceNumber: r.sequenceNumber,
    }));

describe("record sequence number (RFC 6347 §4.1)", () => {
  test.each(["client", "server"] as const)(
    "%s の Finished は epoch 1 の 0 番で、epoch 1 の番号は重複しない",
    async (side) => {
      // Arrange
      const pair = createDtlsPair({ server: { certificateRequest: true } });
      await connectDtlsPair(pair);
      const socket = side === "client" ? pair.client : pair.server;
      const transport =
        side === "client" ? pair.clientTransport : pair.serverTransport;

      // Act: 確立後に application data と close_notify を送る
      await socket.send(Buffer.from("1"));
      await socket.send(Buffer.from("2"));
      await socket.close({ notify: true });

      // Assert: epoch 1 は Finished(0) から 1 ずつ増え、同じ番号を使わない
      const records = sequenceNumbersOf(transport, 1);
      expect(records).toEqual([
        { contentType: ContentType.handshake, sequenceNumber: 0 },
        { contentType: ContentType.applicationData, sequenceNumber: 1 },
        { contentType: ContentType.applicationData, sequenceNumber: 2 },
        { contentType: ContentType.alert, sequenceNumber: 3 },
      ]);
    },
  );
});
