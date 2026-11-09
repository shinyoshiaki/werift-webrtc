import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import type { Address } from "../../../common/src";
import {
  TransactionChallenge,
  TransactionFailed,
  TransactionIntegrityViolation,
} from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { createTurnClient, type TurnProtocol } from "../../src/turn/protocol";
import {
  createLocalTurnServer,
  createSignedTurnSuccessResponse,
  createTurnCredentialHarness,
  createTurnErrorResponse,
  TURN_TEST_PASSWORD,
  TURN_TEST_REALM,
  TURN_TEST_USERNAME,
  timeSettle,
  turnCredentialState,
  turnTestIntegrityKey,
} from "../utils";

/** Peer the TURN requests are about. */
const peer: Address = ["192.0.2.10", 10000];
const freshNonce = Buffer.from("nonce-2");

/** Requests that renew allocation state over an authenticated allocation. */
const authenticatedRequests = [
  {
    name: "ChannelBind",
    method: methods.CHANNEL_BIND,
    act: (turn: TurnProtocol): Promise<unknown> => turn.getChannel(peer),
  },
  {
    name: "CreatePermission",
    method: methods.CREATE_PERMISSION,
    act: (turn: TurnProtocol): Promise<unknown> => turn.getPermission(peer),
  },
  {
    name: "Refresh",
    method: methods.REFRESH,
    act: (turn: TurnProtocol): Promise<unknown> =>
      turn.requestWithRetry(
        new Message(methods.REFRESH, classes.REQUEST).setAttribute(
          "LIFETIME",
          600,
        ),
        turn.server,
      ),
  },
] as const;

/** Under the UDP RTO (50 ms) doubling, a full transaction takes ~6.35 s. */
const PROMPT_MS = 1000;

const turns: TurnProtocol[] = [];
afterEach(async () => {
  await Promise.all(turns.splice(0).map((turn) => turn.close()));
});

function harnessFor(
  options: Parameters<typeof createTurnCredentialHarness>[0],
) {
  const harness = createTurnCredentialHarness(options);
  turns.push(harness.turn);
  return harness;
}

describe.each(["udp", "tcp"] as const)(
  "TURN long-term credential challenge over %s",
  (transport) => {
    test("初回 Allocate の署名なし 401 の後、認証付き Allocate で成功する", async () => {
      // Arrange: 未認証 Allocate に署名なし 401、認証付き Allocate に署名付き成功を返す
      const harness = harnessFor({ transport, authenticated: false });
      harness.answer = (request) =>
        request.getAttributeValue("MESSAGE-INTEGRITY")
          ? createSignedTurnSuccessResponse(request, turnTestIntegrityKey())
          : createTurnErrorResponse(request, 401, {
              realm: TURN_TEST_REALM,
              nonce: harness.nonce,
            });

      // Act: allocation を作る
      await harness.turn.connectionMade();

      // Assert: 2 回目の Allocate が REALM/NONCE で正しく署名され、relay を得ている
      const allocates = harness.requestsOf(methods.ALLOCATE);
      expect(allocates).toHaveLength(2);
      expect(
        parseMessage(allocates[1].bytes, turnTestIntegrityKey()),
      ).toBeDefined();
      expect(harness.turn.relayedAddress).toEqual(["198.51.100.1", 50000]);
      expect(harness.turn.realm).toBe(TURN_TEST_REALM);
      expect(harness.turn.nonce).toEqual(harness.nonce);
    });

    test("認証済み request への署名付き成功レスポンスはそのまま受理される", async () => {
      // Arrange: ChannelBind に署名付き成功を返す
      const harness = harnessFor({ transport });
      const before = turnCredentialState(harness.turn);
      harness.answer = (request) =>
        createSignedTurnSuccessResponse(request, turnTestIntegrityKey());

      // Act: channel を bind する
      const channel = await harness.turn.getChannel(peer);

      // Assert: 1 回の request で bind でき、認証状態は変わらない
      expect(channel.number).toBe(0x4000);
      expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(1);
      expect(turnCredentialState(harness.turn)).toEqual(before);
    });

    test.each(authenticatedRequests)(
      "$name の署名なし 401 は再送を待たずに TransactionChallenge で失敗する",
      async ({ method, act }) => {
        // Arrange: 認証済み request に署名なし 401 (同じ REALM) を返す
        const harness = harnessFor({ transport });
        const before = turnCredentialState(harness.turn);
        harness.answer = (request) =>
          createTurnErrorResponse(request, 401, {
            realm: TURN_TEST_REALM,
            nonce: freshNonce,
          });

        // Act: request を送る
        const { error, elapsedMs } = await timeSettle(act(harness.turn));

        // Assert: 再送もリトライもせず 401 の challenge として即座に失敗する
        expect(error).toBeInstanceOf(TransactionChallenge);
        expect(error).toBeInstanceOf(TransactionFailed);
        expect(
          (error as TransactionFailed).response.getAttributeValue("ERROR-CODE"),
        ).toEqual([401, "error 401"]);
        expect(harness.requestsOf(method)).toHaveLength(1);
        expect(elapsedMs).toBeLessThan(PROMPT_MS);
        // Assert: リトライしないので allocation の認証状態は変わらない
        expect(turnCredentialState(harness.turn)).toEqual(before);
      },
    );

    test("ChannelBind の署名なし 401 は rollback して Send Indication に切り替わる", async () => {
      // Arrange: ChannelBind には署名なし 401、CreatePermission には署名付き成功を返す
      const harness = harnessFor({ transport });
      harness.answer = (request) =>
        request.messageMethod === methods.CHANNEL_BIND
          ? createTurnErrorResponse(request, 401, {
              realm: TURN_TEST_REALM,
              nonce: freshNonce,
            })
          : createSignedTurnSuccessResponse(request, turnTestIntegrityKey());

      // Act: peer にデータを 2 回送る
      const { elapsedMs } = await timeSettle(
        harness.turn.sendData(Buffer.from("first"), peer),
      );
      await harness.turn.sendData(Buffer.from("second"), peer);

      // Assert: 1 回目は即座に Send Indication で送られる
      expect(elapsedMs).toBeLessThan(PROMPT_MS);
      const sends = harness.requestsOf(methods.SEND);
      expect(sends.map((send) => send.message.messageClass)).toEqual([
        classes.INDICATION,
        classes.INDICATION,
      ]);
      expect(sends[0].message.getAttributeValue("DATA")).toEqual(
        Buffer.from("first"),
      );
      // Assert: 失敗した channel は rollback され、次の ChannelBind は新しい番号を使う
      const channelNumbers = harness
        .requestsOf(methods.CHANNEL_BIND)
        .map((bind) => bind.message.getAttributeValue("CHANNEL-NUMBER"));
      expect(channelNumbers).toEqual([0x4000, 0x4001]);
      expect(harness.requestsOf(methods.CREATE_PERMISSION)).toHaveLength(1);
    });

    test.each(authenticatedRequests)(
      "$name の署名なし 438 は新しい NONCE で正しく再署名して 1 回リトライする",
      async ({ method, act }) => {
        // Arrange: 古い NONCE には署名なし 438、新しい NONCE で正しく署名された request には成功を返す
        const harness = harnessFor({ transport });
        harness.answer = (request, index) => {
          const bytes = harness.requests[index].bytes;
          const verified = parseMessage(bytes, turnTestIntegrityKey());
          if (!verified) return undefined;
          return freshNonce.equals(verified.getAttributeValue("NONCE"))
            ? createSignedTurnSuccessResponse(request, turnTestIntegrityKey())
            : createTurnErrorResponse(request, 438, {
                realm: TURN_TEST_REALM,
                nonce: freshNonce,
              });
        };

        // Act: request を送る
        const { error, elapsedMs } = await timeSettle(act(harness.turn));

        // Assert: リトライは 1 回で成功し、サーバー側で MESSAGE-INTEGRITY/FINGERPRINT が検証できる
        expect(error).toBeUndefined();
        expect(elapsedMs).toBeLessThan(PROMPT_MS);
        const sent = harness.requestsOf(method);
        expect(sent).toHaveLength(2);
        const retry = parseMessage(sent[1].bytes, turnTestIntegrityKey());
        expect(retry?.getAttributeValue("NONCE")).toEqual(freshNonce);
        expect(retry?.getAttributeValue("REALM")).toBe(TURN_TEST_REALM);
        expect(retry?.attributesKeys.slice(-2)).toEqual([
          "MESSAGE-INTEGRITY",
          "FINGERPRINT",
        ]);
        expect(sent[1].message.transactionIdHex).not.toBe(
          sent[0].message.transactionIdHex,
        );
        // Assert: allocation の NONCE が更新される
        expect(harness.turn.nonce).toEqual(freshNonce);
      },
    );
  },
);

describe("TURN response authentication over UDP (unreliable)", () => {
  test.each([400, 403, 437, 441, 486, 508])(
    "署名なしの %i は破棄され、再送が続く",
    async (errorCode) => {
      // Arrange: 最初の 2 回は署名なしエラー、3 回目に署名付き成功を返す
      const harness = harnessFor({ transport: "udp" });
      harness.answer = (request, index) =>
        index < 2
          ? createTurnErrorResponse(request, errorCode, {
              realm: TURN_TEST_REALM,
              nonce: freshNonce,
            })
          : createSignedTurnSuccessResponse(request, turnTestIntegrityKey());

      // Act: channel を bind する
      const channel = await harness.turn.getChannel(peer);

      // Assert: エラーは受信しなかったものとして扱われ、再送後の成功で完了する
      expect(channel.number).toBe(0x4000);
      expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(3);
    },
  );

  const otherAddress: Address = ["127.0.0.1", 3479];
  test.each([
    {
      name: "別の transactionId の署名なし 401",
      reply: (request: Message) =>
        createTurnErrorResponse(request, 401, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
          transactionId: randomBytes(12),
        }),
    },
    {
      name: "別のアドレスからの署名なし 401",
      reply: (request: Message) => ({
        bytes: createTurnErrorResponse(request, 401, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
        }),
        from: otherAddress,
      }),
    },
    {
      name: "別のアドレスからの署名なし 438",
      reply: (request: Message) => ({
        bytes: createTurnErrorResponse(request, 438, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
        }),
        from: otherAddress,
      }),
    },
    {
      name: "別 method の署名なし 401",
      reply: (request: Message) =>
        createTurnErrorResponse(
          new Message(methods.REFRESH, classes.REQUEST, request.transactionId),
          401,
          { realm: TURN_TEST_REALM, nonce: freshNonce },
        ),
    },
    {
      name: "不正な MESSAGE-INTEGRITY 付きの 401",
      reply: (request: Message) =>
        createTurnErrorResponse(request, 401, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
          signWith: turnTestIntegrityKey("other.realm"),
        }),
    },
    {
      name: "不正な MESSAGE-INTEGRITY 付きの 438",
      reply: (request: Message) =>
        createTurnErrorResponse(request, 438, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
          signWith: turnTestIntegrityKey("other.realm"),
        }),
    },
    {
      name: "不正な MESSAGE-INTEGRITY 付きの成功",
      reply: (request: Message) =>
        createSignedTurnSuccessResponse(
          request,
          turnTestIntegrityKey("other.realm"),
        ),
    },
    {
      name: "署名なしの成功",
      reply: (request: Message) =>
        new Message(
          request.messageMethod,
          classes.RESPONSE,
          request.transactionId,
        ).bytes,
    },
  ])("$name は無視され、再送が続く", async ({ reply }) => {
    // Arrange: 最初の 2 回は不正なレスポンス、3 回目に署名付き成功を返す
    const harness = harnessFor({ transport: "udp" });
    const before = turnCredentialState(harness.turn);
    harness.answer = (request, index) =>
      index < 2
        ? reply(request)
        : createSignedTurnSuccessResponse(request, turnTestIntegrityKey());

    // Act: channel を bind する
    const channel = await harness.turn.getChannel(peer);

    // Assert: 不正なレスポンスでは完了せず、再送後の成功で完了する
    expect(channel.number).toBe(0x4000);
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(3);
    expect(turnCredentialState(harness.turn)).toEqual(before);
  });
});

describe("TURN response authentication over TCP (reliable)", () => {
  test.each([
    {
      name: "署名なしの 403",
      reply: (request: Message) => createTurnErrorResponse(request, 403),
    },
    {
      name: "不正な MESSAGE-INTEGRITY 付きの 401",
      reply: (request: Message) =>
        createTurnErrorResponse(request, 401, {
          realm: TURN_TEST_REALM,
          nonce: freshNonce,
          signWith: turnTestIntegrityKey("other.realm"),
        }),
    },
    {
      name: "署名なしの成功",
      reply: (request: Message) =>
        new Message(
          request.messageMethod,
          classes.RESPONSE,
          request.transactionId,
        ).bytes,
    },
  ])(
    "$name は即座に TransactionIntegrityViolation で失敗する",
    async ({ reply }) => {
      // Arrange: ChannelBind に検証できないレスポンスを返す
      const harness = harnessFor({ transport: "tcp" });
      const before = turnCredentialState(harness.turn);
      harness.answer = (request) => reply(request);

      // Act: channel を bind する
      const { error, elapsedMs } = await timeSettle(
        harness.turn.getChannel(peer),
      );

      // Assert: 再送を待たず integrity violation として失敗し、認証状態は変わらない
      expect(error).toBeInstanceOf(TransactionIntegrityViolation);
      expect(elapsedMs).toBeLessThan(PROMPT_MS);
      expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(1);
      expect(turnCredentialState(harness.turn)).toEqual(before);
    },
  );

  test("署名なしの 400 は受信しなかったものとして破棄される", async () => {
    // Arrange: 1 回目は署名なし 400、2 回目に署名付き成功を返す
    const harness = harnessFor({ transport: "tcp" });
    harness.answer = (request, index) =>
      index === 0
        ? createTurnErrorResponse(request, 400)
        : createSignedTurnSuccessResponse(request, turnTestIntegrityKey());

    // Act: channel を bind する
    const channel = await harness.turn.getChannel(peer);

    // Assert: 400 では終了せず、次のレスポンスで完了する
    expect(channel.number).toBe(0x4000);
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(2);
  });
});

describe("TURN long-term credential retry decisions", () => {
  test("リトライ後にもう一度 438 を受けたらリトライせず失敗する", async () => {
    // Arrange: 毎回新しい NONCE で署名なし 438 を返す
    const harness = harnessFor({ transport: "udp" });
    harness.answer = (request, index) =>
      createTurnErrorResponse(request, 438, {
        realm: TURN_TEST_REALM,
        nonce: Buffer.from(`nonce-${index + 10}`),
      });

    // Act: channel を bind する
    const { error } = await timeSettle(harness.turn.getChannel(peer));

    // Assert: リトライは 1 回だけで、2 回目の 438 がそのまま投げられる
    expect(error).toBeInstanceOf(TransactionChallenge);
    expect(
      (error as TransactionFailed).response.getAttributeValue("ERROR-CODE")[0],
    ).toBe(438);
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(2);
  });

  test.each([
    {
      name: "nonce cookie の Password algorithms bit",
      code: 438,
      nonce: Buffer.from("obMatJos2AAABrest"),
      attributes: [],
    },
    {
      name: "nonce cookie の Username anonymity bit",
      code: 438,
      nonce: Buffer.from("obMatJos2AAACrest"),
      attributes: [],
    },
    {
      name: "PASSWORD-ALGORITHMS 付きの nonce cookie",
      code: 438,
      nonce: Buffer.from("obMatJos2AAAArest"),
      attributes: [
        ["PASSWORD-ALGORITHMS", Buffer.from([0, 2, 0, 0])] as [
          "PASSWORD-ALGORITHMS",
          Buffer,
        ],
      ],
    },
    {
      name: "別 REALM の 438",
      code: 438,
      nonce: freshNonce,
      realm: "other.realm",
      attributes: [],
    },
    {
      name: "NONCE の無い 438",
      code: 438,
      nonce: undefined,
      attributes: [],
    },
    {
      name: "NONCE の無い 401",
      code: 401,
      nonce: undefined,
      realm: "other.realm",
      attributes: [],
    },
  ])(
    "$name ではリトライせず、認証状態も変えない",
    async ({ code, nonce, realm, attributes }) => {
      // Arrange: 条件を満たさない署名なし challenge を返す
      const harness = harnessFor({ transport: "udp" });
      const before = turnCredentialState(harness.turn);
      harness.answer = (request) =>
        createTurnErrorResponse(request, code, {
          realm: realm ?? TURN_TEST_REALM,
          nonce,
          attributes,
        });

      // Act: channel を bind する
      const { error } = await timeSettle(harness.turn.getChannel(peer));

      // Assert: challenge がそのまま投げられ、request は 1 回だけ
      expect(error).toBeInstanceOf(TransactionChallenge);
      expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(1);
      expect(turnCredentialState(harness.turn)).toEqual(before);
    },
  );

  test("認証済み request への別 REALM の 401 は 1 回リトライし、成功したら新しい鍵を使う", async () => {
    // Arrange: 新しい REALM の鍵で署名された request だけを受け入れる
    const newKey = turnTestIntegrityKey("new.realm");
    const harness = harnessFor({ transport: "udp" });
    harness.answer = (request, index) =>
      parseMessage(harness.requests[index].bytes, newKey)
        ? createSignedTurnSuccessResponse(request, newKey)
        : createTurnErrorResponse(request, 401, {
            realm: "new.realm",
            nonce: freshNonce,
          });

    // Act: channel を bind する
    await harness.turn.getChannel(peer);

    // Assert: 新しい REALM と NONCE が allocation に確定する
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(2);
    expect(turnCredentialState(harness.turn)).toEqual({
      realm: "new.realm",
      nonce: freshNonce,
      integrityKey: newKey,
    });
  });

  test("別 REALM でのリトライが失敗したら allocation の認証状態を元に戻す", async () => {
    // Arrange: 何を送っても別 REALM の署名なし 401 を返す
    const harness = harnessFor({ transport: "udp" });
    const before = turnCredentialState(harness.turn);
    harness.answer = (request) =>
      createTurnErrorResponse(request, 401, {
        realm: "new.realm",
        nonce: freshNonce,
      });

    // Act: channel を bind する
    const { error } = await timeSettle(harness.turn.getChannel(peer));

    // Assert: リトライは 1 回で失敗し、認証状態は元に戻る
    expect(error).toBeInstanceOf(TransactionChallenge);
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(2);
    expect(turnCredentialState(harness.turn)).toEqual(before);
  });

  test("異なる REALM の 401 で並行する request が失敗しても allocation の認証状態は変わらない", async () => {
    // Arrange: request ごとに別の REALM の署名なし 401 を返す
    const harness = harnessFor({ transport: "udp" });
    const before = turnCredentialState(harness.turn);
    let count = 0;
    harness.answer = (request) =>
      createTurnErrorResponse(request, 401, {
        realm: `realm-${Math.floor(count++ / 2)}`,
        nonce: freshNonce,
      });

    // Act: CreatePermission と ChannelBind を同時に送り、両方を失敗させる
    const [permission, channel] = await Promise.all([
      timeSettle(harness.turn.getPermission(peer)),
      timeSettle(harness.turn.getChannel(peer)),
    ]);

    // Assert: どちらも失敗し、失敗した認証情報は共有状態に残らない
    expect(permission.error).toBeDefined();
    expect(channel.error).toBeDefined();
    expect(turnCredentialState(harness.turn)).toEqual(before);
  });

  test("CreatePermission と ChannelBind が同時に 438 を受けてもどちらのリトライも成功する", async () => {
    // Arrange: 古い NONCE には request ごとに別の新しい NONCE で 438、新しい NONCE なら成功を返す
    const harness = harnessFor({ transport: "udp" });
    const issued: Buffer[] = [];
    harness.answer = (request, index) => {
      const verified = parseMessage(
        harness.requests[index].bytes,
        turnTestIntegrityKey(),
      );
      if (!verified) return undefined;
      if (
        issued.some((nonce) =>
          nonce.equals(verified.getAttributeValue("NONCE")),
        )
      ) {
        return createSignedTurnSuccessResponse(request, turnTestIntegrityKey());
      }
      const nonce = Buffer.from(`fresh-${issued.length}`);
      issued.push(nonce);
      return createTurnErrorResponse(request, 438, {
        realm: TURN_TEST_REALM,
        nonce,
      });
    };

    // Act: CreatePermission と ChannelBind を同時に送る
    await Promise.all([
      harness.turn.getPermission(peer),
      harness.turn.getChannel(peer),
    ]);

    // Assert: どちらも 1 回のリトライで成功し、NONCE は後から来た新しい値になる
    expect(harness.requestsOf(methods.CREATE_PERMISSION)).toHaveLength(2);
    expect(harness.requestsOf(methods.CHANNEL_BIND)).toHaveLength(2);
    expect(issued.some((nonce) => nonce.equals(harness.turn.nonce!))).toBe(
      true,
    );
  });
});

describe("werift TURN server nonce expiry", () => {
  test.each(["udp", "tcp"] as const)(
    "%s: nonce 失効後の 438 から ChannelBind と Refresh が回復する",
    async (transport) => {
      // Arrange: nonce の有効期限を時計で進められる werift TURN server に allocation を作る
      let offsetMs = 0;
      const server = await createLocalTurnServer("127.0.0.1", {
        nonceLifetime: 60,
        now: () => Date.now() + offsetMs,
      });
      try {
        const turn = await createTurnClient(
          {
            address: server.address!,
            username: TURN_TEST_USERNAME,
            password: TURN_TEST_PASSWORD,
          },
          { transport },
        );
        turns.push(turn);
        const allocatedNonce = turn.nonce;
        offsetMs = 61_000;

        // Act: nonce 失効後に ChannelBind と Refresh を送る
        const channel = await turn.getChannel(peer);
        const nonceAfterBind = turn.nonce;
        offsetMs = 122_000;
        const [refresh] = await turn.requestWithRetry(
          new Message(methods.REFRESH, classes.REQUEST).setAttribute(
            "LIFETIME",
            600,
          ),
          turn.server,
        );

        // Assert: どちらも 438 の後に新しい NONCE で成功する
        expect(channel.number).toBe(0x4000);
        expect(refresh.messageClass).toBe(classes.RESPONSE);
        expect(nonceAfterBind).not.toEqual(allocatedNonce);
        expect(turn.nonce).not.toEqual(nonceAfterBind);
      } finally {
        await server.close();
      }
    },
  );
});
