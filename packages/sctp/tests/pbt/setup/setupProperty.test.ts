import { vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { SCTP, SCTP_STATE } from "../../../src";
import { InitChunk } from "../../../src/chunk";
import { createLossyEndpointPair, flushImmediates } from "../../utils";

/**
 * Association setup property (RFC 9260 §5.2.1, §8.5.1): for random role
 * pairs, start orders and 25 % packet loss during the handshake, INIT is
 * always sent with verification tag 0 and both ends become established.
 *
 * CI runs `WERIFT_SCTP_SETUP_SEEDS` (default 100) seeds from
 * `WERIFT_SCTP_SETUP_SEED` (default 1). A failing title prints the replay
 * environment.
 */
describe(
  "SCTP association setup under random start order and handshake loss (property)",
  propertyOptions(),
  () => {
    const { cases, replay, title } = propertySeeds("WERIFT_SCTP_SETUP", {
      seeds: 100,
    });
    /**
     * The roles werift supports: a client initiates, a server only answers.
     * Two clients emulate a peer that also sends INIT (usrsctp / dcsctp).
     */
    const ROLE_PAIRS = [
      ["client", "server"],
      ["server", "client"],
      ["client", "client"],
    ] as const;

    test.each(cases)(
      title("sends INIT with tag 0 and establishes both ends"),
      async ({ seed }) => {
        // Arrange: 役割の組を乱数で選んだ 2 端点と、ハンドシェイク中に 25% のパケットを落とす経路
        const random = seededRandom(seed).next;
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
  },
);
