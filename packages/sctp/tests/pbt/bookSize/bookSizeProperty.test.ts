import { describe, expect, test } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { dataChunkBookSize } from "../../../src";
import {
  DataChunk,
  SCTP_COMMON_HEADER_SIZE,
  serializePacket,
} from "../../../src/chunk";

/**
 * DATA chunk book size property: what a DATA chunk counts in flightSize,
 * cwnd and the peer's rwnd (`dataChunkBookSize`) is its size in a serialized
 * packet (16-byte header and the payload padded to 4), for any payload of
 * 0 to 1200 bytes.
 *
 * CI runs `WERIFT_SCTP_BOOK_SIZE_SEEDS` (default 200) seeds from
 * `WERIFT_SCTP_BOOK_SIZE_SEED` (default 1). A failing title prints the replay
 * environment.
 */
describe("sctp DATA chunk book size (property)", propertyOptions(), () => {
  const { cases, replay, title } = propertySeeds("WERIFT_SCTP_BOOK_SIZE", {
    seeds: 200,
  });

  test.each(cases)(
    title(
      "a DATA chunk books its size on the wire (16-byte header and padded payload)",
    ),
    ({ seed }) => {
      // Arrange: 0〜1200 バイトのペイロードの DATA チャンクを作る。
      const random = seededRandom(seed).next;
      const length = Math.floor(random() * 1201);
      const chunk = new DataChunk(0, undefined);
      chunk.userData = Buffer.alloc(length);

      // Act: 計上する大きさと、パケットにしたときの大きさを求める。
      const booked = dataChunkBookSize(length);
      const onWire =
        serializePacket(5000, 5000, 0, chunk).length - SCTP_COMMON_HEADER_SIZE;

      // Assert: 計上はパケット上のチャンクの大きさ (共通ヘッダを除く) に等しい。
      expect(booked, `${replay(seed)} length=${length}`).toBe(onWire);
    },
  );
});
