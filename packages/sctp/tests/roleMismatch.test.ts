import { setTimeout } from "timers/promises";

import { SCTP, SCTP_STATE } from "../src";
import { InitAckChunk, InitChunk } from "../src/chunk";
import {
  collectMessages,
  createSctpEndpointPair,
  LEGACY_INITIATOR_IGNORED,
  createControlledTransport,
  localVerificationTagOf,
  receiveInitAndTakeCookie,
  receiveInitTagged,
  sentTagsAndTypes,
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

  test("相手の INIT に start() 前に答えた後でも、自分の INIT は verification tag 0 で送る (RFC 9260 §8.5.1)", async () => {
    // Arrange: passive のまま相手の INIT に INIT_ACK で答え、相手の tag を覚えた association
    // (WebRTC sets the remote port from SDP before SCTP starts)
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.server(transport);
    sctp.setRemotePort(5000);
    await receiveInitAndTakeCookie(sctp, sent);

    // Act: その後 initiator として start する
    sctp.isServer = false;
    await sctp.start(5000);

    // Assert: INIT_ACK は相手の tag で、INIT は tag 0 で送られる
    expect(sentTagsAndTypes(sent)).toEqual([
      [0x5678, InitAckChunk.type],
      [0, InitChunk.type],
    ]);
    await sctp.stop();
  });

  test("自分の INIT を待つ間に、自分の verification tag 付きで届いた INIT (旧 werift) にも INIT_ACK で答える", async () => {
    // Arrange: INIT を送って COOKIE_WAIT にいる initiator
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.client(transport);
    await sctp.start(5000);
    expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

    // Act: 相手が学習済みの自分の tag を付けた INIT を受け取る
    await receiveInitTagged(sctp, localVerificationTagOf(sctp));

    // Assert: 破棄せず、相手の initiate tag 宛てに INIT_ACK を返す
    expect(sentTagsAndTypes(sent).at(-1)).toEqual([0x5678, InitAckChunk.type]);
    await sctp.stop();
  });

  test("自分のものでも 0 でもない verification tag の INIT は破棄する", async () => {
    // Arrange: INIT を送って COOKIE_WAIT にいる initiator
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.client(transport);
    await sctp.start(5000);
    const before = sent.length;

    // Act: 無関係な tag の INIT を受け取る
    await receiveInitTagged(sctp, (localVerificationTagOf(sctp) ^ 1) >>> 0);

    // Assert: 何も返さない
    expect(sent.length).toBe(before);
    await sctp.stop();
  });
});
