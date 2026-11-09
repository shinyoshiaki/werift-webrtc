import { afterEach, describe, expect, test } from "vitest";
import { TransactionFailed } from "../../src/exceptions";
import { methods } from "../../src/stun/const";
import {
  createRelayPairOnLocalTurnServer,
  makeTurnChannelsDue,
  recordTurnRequests,
  TURN_TEST_USERNAME,
  timeSettle,
  turnAllocations,
  turnCredentialState,
} from "../utils";

/**
 * End-to-end scenarios of the long-term credential challenges werift's own
 * TURN server sends unsigned (401/438) to authenticated requests, seen from
 * two ICE agents exchanging data over their relays.
 */

/** Before the fix each challenge waited out the transaction (~6.35 s on UDP). */
const PROMPT_MS = 1500;

const pairs: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(pairs.splice(0).map((pair) => pair.close()));
});

async function relayPair(
  transport: "udp" | "tcp" | "tls",
  options?: Parameters<typeof createRelayPairOnLocalTurnServer>[1],
) {
  const pair = await createRelayPairOnLocalTurnServer(transport, options);
  pairs.push(pair);
  const [allocation] = turnAllocations(pair.a);
  return { ...pair, turn: allocation!.turn };
}

describe.each(["udp", "tcp", "tls"] as const)(
  "werift TURN server credential challenges end to end over %s",
  (transport) => {
    test("nonce が失効しても ChannelBind 更新が 438 から回復し、relay 経由の送受信が続く", async () => {
      // Arrange: relay 同士で接続した後、サーバーの nonce を失効させ、A の channel を更新対象にする
      const { a, b, turn, advanceServerClock } = await relayPair(transport, {
        nonceLifetime: 60,
      });
      const nonceBefore = turn.nonce;
      advanceServerClock(61_000);
      const channels = makeTurnChannelsDue(turn);
      const requests = recordTurnRequests(turn);
      const received = b.onData.asPromise();

      // Act: A から B へデータを送る(送信前に ChannelBind の更新が走る)
      const sent = await timeSettle(a.send(Buffer.from("after-stale-nonce")));
      const [data] = await received;

      // Assert: 署名なし 438 を受けて新しい NONCE で 1 回だけリトライし、待たずに送れる
      expect(sent.error).toBeUndefined();
      expect(sent.elapsedMs).toBeLessThan(PROMPT_MS);
      expect(requests.attempts(methods.CHANNEL_BIND)).toEqual([438, "success"]);
      expect(turn.nonce).not.toEqual(nonceBefore);
      // Assert: channel は更新済みのまま残り、データは B に届く
      expect(channels.length).toBeGreaterThan(0);
      expect(
        channels.every((channel) => channel.refreshAt > Date.now() / 1000),
      ).toBe(true);
      expect(data.toString()).toBe("after-stale-nonce");

      // Act: 逆方向にも送る
      const replied = a.onData.asPromise();
      await b.send(Buffer.from("reply-after-stale-nonce"));

      // Assert: B から A への relay 経路も生きている
      const [reply] = await replied;
      expect(reply.toString()).toBe("reply-after-stale-nonce");
    });

    test("認証情報を取り消された後の ChannelBind と CreatePermission は 401 でリトライせず即座に失敗する", async () => {
      // Arrange: relay 同士で接続した後、サーバー側でユーザーを取り消し、A の channel を更新対象にする
      const { a, b, turn, credentials } = await relayPair(transport);
      const stateBefore = turnCredentialState(turn);
      delete credentials[TURN_TEST_USERNAME];
      makeTurnChannelsDue(turn);
      const requests = recordTurnRequests(turn);

      // Act: A から B へデータを送る(ChannelBind の更新と、Send Indication 用の CreatePermission が拒否される)
      const sent = await timeSettle(a.send(Buffer.from("after-revocation")));

      // Assert: 同じ REALM の署名なし 401 なのでどちらもリトライせず、待たずに 401 で失敗する
      expect(sent.elapsedMs).toBeLessThan(PROMPT_MS);
      expect(sent.error).toBeInstanceOf(TransactionFailed);
      expect(
        (sent.error as TransactionFailed).response.getAttributeValue(
          "ERROR-CODE",
        )[0],
      ).toBe(401);
      for (const method of [methods.CHANNEL_BIND, methods.CREATE_PERMISSION]) {
        const attempts = requests.attempts(method);
        expect(attempts.length).toBeGreaterThan(0);
        expect(attempts.every((result) => result === 401)).toBe(true);
        expect(attempts).toHaveLength(requests.calls(method).length);
      }
      // Assert: 拒否された challenge で allocation の認証状態は変わらない
      expect(turnCredentialState(turn)).toEqual(stateBefore);

      // Act: 認証を必要としない B の既存 channel で A へ送る
      const received = a.onData.asPromise();
      await b.send(Buffer.from("existing-channel"));

      // Assert: サーバー上の既存 channel は有効なまま使える
      const [data] = await received;
      expect(data.toString()).toBe("existing-channel");
    });
  },
);
