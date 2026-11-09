import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { SCTP, SCTP_STATE } from "../src";
import {
  CookieAckChunk,
  CookieEchoChunk,
  InitAckChunk,
  InitChunk,
} from "../src/chunk";
import {
  collectMessages,
  createControlledTransport,
  createSctpEndpointPair,
  LEGACY_INITIATOR_IGNORED,
  localVerificationTagOf,
  receiveCookieEcho,
  receiveInitAck,
  receiveInitAndTakeCookie,
  receiveInitTagged,
  sentChunkTypes,
  sentTagsAndTypes,
} from "./utils";

/**
 * 両端が INIT を送る衝突 (RFC 9260 §5.2.1)。usrsctp / dcsctp は両端から INIT を
 * 送り、werift <= 0.26 の initiator は相手の INIT / COOKIE_ECHO を無視する。
 */
describe("SCTP INIT collision", () => {
  test("両端が INIT を送る同時開始でも確立する", async () => {
    // Arrange: 両端が initiator
    const { first, second, connected, stop } = createSctpEndpointPair({
      roles: ["client", "client"],
    });
    try {
      // Act: 両端が同時に開始し、確立後にメッセージを送る
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

  test("相手の initiator が自分の INIT / COOKIE_ECHO を無視しても、相手の INIT に答えて確立する", async () => {
    // Arrange: 両端が initiator。second は first の INIT / COOKIE_ECHO を無視する (werift <= 0.26)
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

  test("start() 前に相手の INIT に答えた後でも、自分の INIT は verification tag 0 で送る (RFC 9260 §8.5.1)", async () => {
    // Arrange: passive のまま相手の INIT に INIT_ACK で答え、相手の tag を覚えた association
    // (WebRTC は SCTP の開始前に SDP から remote port を設定する)
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

  test("start() 前に相手の INIT / COOKIE_ECHO で確立した association は、start() で INIT を送り直さない", async () => {
    // Arrange: passive のまま相手の INIT と COOKIE_ECHO を受けて確立した association
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.server(transport);
    sctp.setRemotePort(5000);
    const cookie = await receiveInitAndTakeCookie(sctp, sent);
    await receiveCookieEcho(sctp, cookie);
    expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);

    // Act: その後 initiator として start する
    sctp.isServer = false;
    await sctp.start(5000);

    // Assert: INIT は送らず、確立した association はそのまま
    expect(sentChunkTypes(sent)).toEqual([
      InitAckChunk.type,
      CookieAckChunk.type,
    ]);
    expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    await sctp.stop();
  });

  test("自分の INIT を待つ間に、自分の verification tag 付きで届いた INIT (werift <= 0.26) にも INIT_ACK で答える", async () => {
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

describe("SCTP start chunk send ordering", () => {
  test("開始側は INIT の送信完了前に届いた INIT_ACK も処理する", async () => {
    // Arrange: INIT の送信完了を保留する開始側
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    control.holdSends();
    const starting = sctp.start(5001);
    await setTimeout(0);

    try {
      // Assert: 送信完了前に COOKIE_WAIT へ進んでいる
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

      // Act: INIT の送信完了前に INIT_ACK を受信し、その後で送信を完了させる
      const handling = receiveInitAck(sctp);
      await setTimeout(0);
      control.release();
      await Promise.all([starting, handling]);

      // Assert: INIT_ACK は捨てられず、COOKIE_ECHO を送って COOKIE_ECHOED へ進む
      expect(sentChunkTypes(control.sent)).toEqual([
        InitChunk.type,
        CookieEchoChunk.type,
      ]);
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
    } finally {
      control.release();
      await sctp.stop();
    }
  });

  test("開始側は COOKIE_ECHO の送信完了前に COOKIE_ECHOED へ進み、送信中の重複 INIT_ACK を無視する", async () => {
    // Arrange: INIT 送信済みの開始側で、以降の送信を保留する
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    await sctp.start(5001);
    control.holdSends();

    try {
      // Act: INIT_ACK を受信し、COOKIE_ECHO の送信完了待ちに入る
      const handling = receiveInitAck(sctp);
      await setTimeout(0);

      // Assert: 送信完了前に COOKIE_ECHOED へ進んでいる
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);

      // Act: 送信中に重複した INIT_ACK を受信し、その後で送信を完了させる
      await receiveInitAck(sctp);
      control.release();
      await handling;

      // Assert: 重複 INIT_ACK に COOKIE_ECHO を送り直さず、COOKIE_ECHOED を保つ
      expect(sentChunkTypes(control.sent)).toEqual([
        InitChunk.type,
        CookieEchoChunk.type,
      ]);
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
    } finally {
      control.release();
      await sctp.stop();
    }
  });

  test("開始側の COOKIE_ECHO 送信中に stop しても、送信完了で状態は戻らない", async () => {
    // Arrange: COOKIE_ECHO の送信完了待ちの開始側
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    await sctp.start(5001);
    control.holdSends();
    const handling = receiveInitAck(sctp);
    await setTimeout(0);

    // Act: 送信中に stop し、その後で送信を完了させる
    const stopping = sctp.stop();
    control.release();
    await Promise.all([handling, stopping]);

    // Assert: 遅れて完了した送信処理が CLOSED を上書きしない
    expect(sctp.associationState).toBe(SCTP_STATE.CLOSED);
    expect(sctp.state).toBe("closed");
  });

  test("INIT の送信失敗は損失として扱い、T1 が INIT を再送する", async () => {
    // Arrange: 送信が失敗する transport と短い RTO の開始側
    vi.useFakeTimers();
    const control = createControlledTransport();
    const sctp = SCTP.client(control.transport, 5000);
    (sctp as unknown as { rto: number }).rto = 0.001;
    control.failSends();

    try {
      // Act: INIT を送信する
      await sctp.start(5001);

      // Assert: COOKIE_WAIT に進み、T1 による再送を待つ
      expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);

      // Act: 送信を回復させ、T1 を満了させる
      control.restoreSends();
      await vi.advanceTimersByTimeAsync(5);

      // Assert: T1 が INIT を再送している
      expect(sentChunkTypes(control.sent)).toContain(InitChunk.type);
    } finally {
      await sctp.stop();
      vi.useRealTimers();
    }
  });

  test("応答側の COOKIE_ACK 送信失敗は損失として扱い、再送された COOKIE_ECHO に同じ association で応答する", async () => {
    // Arrange: INIT を受けて state cookie を発行した応答側
    const control = createControlledTransport();
    const sctp = SCTP.server(control.transport, 5000);
    sctp.setRemotePort(5001);
    const cookie = await receiveInitAndTakeCookie(sctp, control.sent);

    try {
      // Act: COOKIE_ACK の送信が失敗する状態で COOKIE_ECHO を受信する
      control.failSends();
      await receiveCookieEcho(sctp, cookie);

      // Assert: RFC 9260 §5.1 (D) どおり確立する
      expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);

      // Act: 開始側が COOKIE_ECHO を再送し、今度は送信が成功する
      control.restoreSends();
      await receiveCookieEcho(sctp, cookie);

      // Assert: 同じ cookie 鍵の association が COOKIE_ACK を返す
      expect(sentChunkTypes(control.sent).at(-1)).toBe(CookieAckChunk.type);
      expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    } finally {
      await sctp.stop();
    }
  });
});
