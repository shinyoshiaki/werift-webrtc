import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { SCTP, SCTP_STATE } from "../src";
import {
  CookieAckChunk,
  CookieEchoChunk,
  DataChunk,
  InitAckChunk,
  InitChunk,
  parsePacket,
  SackChunk,
  serializePacket,
} from "../src/chunk";
import {
  collectMessages,
  createControlledTransport,
  createLossyEndpointPair,
  createResetRequestChunk,
  createSctpEndpointPair,
  createSeededRandom,
  flushImmediates,
  LEGACY_INITIATOR_IGNORED,
  localVerificationTagOf,
  propertySeeds,
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
    // 接続状態も connected のまま (connecting へ戻らない)
    expect(sctp.state).toBe("connected");
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

describe("SCTP 遅延した重複 INIT", () => {
  test("COOKIE_ECHOED 中に DATA を受信した後の重複 INIT は、累積 TSN を巻き戻さない", async () => {
    // Arrange: INIT_ACK (initialTsn=1) を受けて COOKIE_ECHOED、COOKIE_ACK 前に DATA 1 が先着
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.client(transport, 5000);
    await sctp.start(5001);
    await receiveInitAck(sctp);
    expect(sctp.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
    await receiveData(sctp, 1);
    expect(lastSackCumulativeTsn(sent)).toBe(1);

    // Act: 遅延した重複 INIT (initialTsn=1) を受信し、その後 DATA 2 を受信する
    await receiveInitTagged(sctp, 0);
    await receiveData(sctp, 2);

    // Assert: DATA 2 に対する SACK の累積確認は 2 へ進む (1 → 0 に戻らない)
    expect(lastSackCumulativeTsn(sent)).toBe(2);
    await sctp.stop();
  });
});

describe("SCTP 確立済み responder への重複 INIT", () => {
  test("DATA を受信して確立済みの responder は、重複 INIT の後も累積 TSN を巻き戻さない", async () => {
    // Arrange: INIT (initialTsn=1) / COOKIE_ECHO で確立し、DATA 1 を確認済みの responder
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.server(transport);
    sctp.setRemotePort(5000);
    const cookie = await receiveInitAndTakeCookie(sctp, sent);
    await receiveCookieEcho(sctp, cookie);
    expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    await receiveData(sctp, 1);
    expect(lastSackCumulativeTsn(sent)).toBe(1);

    // Act: 遅延した重複 INIT を受信し、その後 DATA 2 を受信する
    await receiveInitTagged(sctp, 0);
    await receiveData(sctp, 2);

    // Assert: DATA 2 に対する SACK の累積確認は 2 へ進む
    expect(lastSackCumulativeTsn(sent)).toBe(2);
    await sctp.stop();
  });
});

describe("SCTP 確立済み responder への再開始 INIT", () => {
  test("別の initiate tag / 初期 TSN で相手が再開始したら、受信 TSN も新しい初期 TSN から始める", async () => {
    // Arrange: 初期 TSN 1 で確立し、DATA 1 を確認済みの responder
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.server(transport);
    sctp.setRemotePort(5000);
    const cookie = await receiveInitAndTakeCookie(sctp, sent);
    await receiveCookieEcho(sctp, cookie);
    await receiveData(sctp, 1);
    expect(lastSackCumulativeTsn(sent)).toBe(1);

    // Act: 別の initiate tag・初期 TSN 100 の INIT を受け、DATA 100 を受信する
    await receiveInitTagged(sctp, 0, { initiateTag: 0x9999, initialTsn: 100 });
    await receiveData(sctp, 100);

    // Assert: 累積確認は 100 へ進む (旧 TSN 1 を待ち続けない)
    expect(lastSackCumulativeTsn(sent)).toBe(100);
    await sctp.stop();
  });

  test("再開始 INIT は、旧 TSN 空間で保留中の stream reset を破棄する", async () => {
    // Arrange: 初期 TSN 1 で確立し、未受信の TSN 5 を境界とする reset request を保留中の responder
    const { transport, sent } = createControlledTransport();
    const sctp = SCTP.server(transport);
    sctp.setRemotePort(5000);
    const cookie = await receiveInitAndTakeCookie(sctp, sent);
    await receiveCookieEcho(sctp, cookie);
    await receiveData(sctp, 1);
    const internal = sctp as any;
    await internal.receiveChunk(
      createResetRequestChunk({ requestSequence: 1, lastTsn: 5, streams: [0] }),
    );
    expect(internal.deferredReset).toBeDefined();

    // Act: 別の initiate tag・初期 TSN 100 の INIT で相手が再開始する
    await receiveInitTagged(sctp, 0, { initiateTag: 0x9999, initialTsn: 100 });

    // Assert: 旧 association の reset request と応答結果は持ち越さない
    expect(internal.deferredReset).toBeUndefined();
    expect(internal.lastReconfigResult).toBeUndefined();
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

async function receiveData(sctp: SCTP, tsn: number) {
  const chunk = new DataChunk(0, undefined);
  chunk.flags = 0x03;
  chunk.tsn = tsn;
  chunk.streamId = 1;
  chunk.streamSeqNum = tsn - 1;
  chunk.protocol = 51;
  chunk.userData = Buffer.from("x");
  const internals = sctp as any;
  await internals.handleData(
    serializePacket(5001, 5000, internals.localVerificationTag, chunk),
  );
}

function lastSackCumulativeTsn(sent: Buffer[]) {
  const sacks = sent
    .flatMap((b) => parsePacket(b)[3])
    .filter((c) => c.type === SackChunk.type) as SackChunk[];
  return sacks.at(-1)?.cumulativeTsn;
}

describe("SCTP association setup under random start order and handshake loss (property)", () => {
  const { seeds, replay } = propertySeeds("WERIFT_SCTP_SETUP", { seeds: 100 });
  /**
   * The roles werift supports: a client initiates, a server only answers.
   * Two clients emulate a peer that also sends INIT (usrsctp / dcsctp).
   */
  const ROLE_PAIRS = [
    ["client", "server"],
    ["server", "client"],
    ["client", "client"],
  ] as const;

  test.each(seeds.map((seed) => [seed, replay(seed)] as const))(
    `sends INIT with tag 0 and establishes both ends (seed %i, replay: %s)`,
    async (seed, _replay) => {
      // Arrange: 役割の組を乱数で選んだ 2 端点と、ハンドシェイク中に 25% のパケットを落とす経路
      const random = createSeededRandom(seed);
      const roles = ROLE_PAIRS[Math.floor(random() * ROLE_PAIRS.length)];
      const { endpoints, states, control, stop } = createLossyEndpointPair([
        roles[0],
        roles[1],
      ]);
      try {
        control.dropIf = () => random() < 0.25;
        // client は必ず start() する。server は 2 割の確率で start() せず、相手の INIT だけで確立する
        const startAt = roles.map((role) =>
          role === "server" && random() < 0.2
            ? undefined
            : Math.floor(random() * 6),
        );

        // start() しない server も、WebRTC と同じく SDP 由来の相手ポートは知っている
        for (const [index, at] of startAt.entries()) {
          if (at === undefined) endpoints[index].setRemotePort(5000);
        }

        // Act: start() の時期と、配送・時間経過の進み方を乱数で織り交ぜる
        for (let step = 0; step < 8; step++) {
          for (const [index, at] of startAt.entries()) {
            if (at === step) void endpoints[index].start(5000);
          }
          await flushImmediates(Math.floor(random() * 4));
          if (random() < 0.5) {
            await vi.advanceTimersByTimeAsync(Math.floor(random() * 4_000));
          }
        }
        // Act: 損失を止め、T1 の再送で確立するまで時間を進める
        control.dropIf = undefined;
        for (
          let i = 0;
          i < 40 &&
          endpoints.some(
            (sctp) => sctp.associationState !== SCTP_STATE.ESTABLISHED,
          );
          i++
        ) {
          await vi.advanceTimersByTimeAsync(5_000);
          await flushImmediates();
        }

        // Assert: INIT は誰がいつ送っても verification tag 0 (RFC 9260 §8.5.1)
        const initTags = control.wire
          .filter(({ chunks }) => chunks.some((c) => c instanceof InitChunk))
          .map(({ tag }) => tag);
        expect(initTags.filter((tag) => tag !== 0)).toEqual([]);
        // Assert: 両端が ESTABLISHED / connected になり、connected から後退しない
        for (const [index, sctp] of endpoints.entries()) {
          expect(sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
          expect(sctp.state).toBe("connected");
          const history = states[index];
          expect(history.slice(history.indexOf("connected"))).toEqual([
            "connected",
          ]);
        }
        // Assert: 確立した association で両方向にメッセージが届く
        const received: string[] = [];
        endpoints[1].onReceive.subscribe((_s, _p, data) =>
          received.push(`1:${data}`),
        );
        endpoints[0].onReceive.subscribe((_s, _p, data) =>
          received.push(`0:${data}`),
        );
        await endpoints[0].send(1, 51, Buffer.from("a"));
        await endpoints[1].send(1, 51, Buffer.from("b"));
        await flushImmediates();
        expect(received.sort()).toEqual(["0:b", "1:a"]);
      } finally {
        await stop();
      }
    },
  );
});
