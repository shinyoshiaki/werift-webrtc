import { setTimeout } from "timers/promises";

import { SCTP_STATE } from "../src";
import {
  collectMessages,
  createSctpEndpointPair,
  LEGACY_INITIATOR_IGNORED,
} from "./utils";

/**
 * 開始側 (INIT 送信側) を別の規則で決める peer との組み合わせ。旧 werift は
 * ICE role、現行は DTLS role で決めるため、両端が INIT を送る / 両端が待つ
 * 組み合わせが起こり得る。
 */
describe("SCTP initiator role mismatch", () => {
  test("両端が INIT を送り、相手が INIT / COOKIE_ECHO を無視しても、相手の INIT に答えて確立する", async () => {
    // Arrange: 両端が initiator。second は first の INIT / COOKIE_ECHO を無視する (旧 werift)。
    const { first, second, connected, stop } = createSctpEndpointPair({
      roles: ["client", "client"],
      ignoredBySecond: LEGACY_INITIATOR_IGNORED,
    });
    try {
      // Act: 両端が開始し、確立後に双方向でメッセージを送る
      await Promise.all([first.start(5000), second.start(5000)]);
      await connected;
      const toSecond = collectMessages(second, 1);
      const toFirst = collectMessages(first, 1);
      await first.send(1, 51, Buffer.from("from-first"));
      await second.send(1, 51, Buffer.from("from-second"));

      // Assert: 両端とも ESTABLISHED になり、双方向に届く
      expect(first.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect(second.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect((await toSecond.done).map((data) => data.toString())).toEqual([
        "from-first",
      ]);
      expect((await toFirst.done).map((data) => data.toString())).toEqual([
        "from-second",
      ]);
    } finally {
      await stop();
    }
  });

  test("両端が INIT を送る (どちらも相手の INIT に答える) 同時開始でも確立する", async () => {
    // Arrange: 両端が現行の initiator
    const { first, second, connected, stop } = createSctpEndpointPair({
      roles: ["client", "client"],
    });
    try {
      // Act: 両端が同時に開始する
      await Promise.all([first.start(5000), second.start(5000)]);
      await connected;
      const toSecond = collectMessages(second, 1);
      await first.send(1, 51, Buffer.from("simultaneous"));

      // Assert: 両端とも ESTABLISHED になり、メッセージが届く
      expect(first.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect(second.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect((await toSecond.done).map((data) => data.toString())).toEqual([
        "simultaneous",
      ]);
    } finally {
      await stop();
    }
  });

  test("両端が INIT を待つとき、passive 側の fallback INIT で確立する", async () => {
    // Arrange: 両端が passive (どちらも INIT を送らない)
    const { first, second, connected, stop } = createSctpEndpointPair({
      roles: ["server", "server"],
    });
    try {
      await Promise.all([first.start(5000), second.start(5000)]);
      await setTimeout(50);
      // 前提: どちらも INIT を送らず、確立していない
      expect(first.associationState).toBe(SCTP_STATE.CLOSED);
      expect(second.associationState).toBe(SCTP_STATE.CLOSED);

      // Act: first が fallback INIT を送る
      const sent = await first.startPassiveFallbackInit();
      await connected;

      // Assert: fallback INIT を送り、両端とも ESTABLISHED になる
      expect(sent).toBe(true);
      expect(first.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect(second.associationState).toBe(SCTP_STATE.ESTABLISHED);
    } finally {
      await stop();
    }
  });

  test("相手の INIT を受け取った passive 側は fallback INIT を送らない", async () => {
    // Arrange: 通常の initiator / passive の組み合わせで確立する
    const { first, second, connected, stop } = createSctpEndpointPair({
      roles: ["server", "client"],
    });
    try {
      await Promise.all([first.start(5000), second.start(5000)]);
      await connected;

      // Act: 確立後に passive 側の fallback を呼ぶ
      const sent = await first.startPassiveFallbackInit();

      // Assert: INIT は送らず、確立した association はそのまま
      expect(sent).toBe(false);
      expect(first.associationState).toBe(SCTP_STATE.ESTABLISHED);
    } finally {
      await stop();
    }
  });
});
