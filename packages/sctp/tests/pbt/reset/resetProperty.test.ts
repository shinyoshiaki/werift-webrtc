import { vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { SCTP_STATE } from "../../../src";
import {
  createLossyPrSctpPair,
  flushImmediates,
  outboundQueueOf,
} from "../../utils";

/**
 * Stream reset property (RFC 6525): with every packet lost at random (20 %)
 * in both directions, every outgoing reset completes and every message sent
 * before it is delivered exactly once.
 *
 * CI runs `WERIFT_SCTP_RESET_SEEDS` (default 60) seeds from
 * `WERIFT_SCTP_RESET_SEED` (default 1). A failing title prints the replay
 * environment.
 */
describe(
  "stream reset under seeded random loss of every packet (property)",
  propertyOptions(),
  () => {
    const { cases, replay, title } = propertySeeds("WERIFT_SCTP_RESET", {
      seeds: 60,
    });
    const LOSS_RATE = 0.2;
    const STREAMS = [1, 2, 3, 4, 5, 6];

    test.each(cases)(
      title("completes every reset and delivers every message once"),
      async ({ seed }) => {
        // Arrange: 両端が全 stream で送信済み (reset に逆方向の request が伴う) のペアと、全パケットを乱数で落とす経路
        const pair = await createLossyPrSctpPair();
        try {
          const random = seededRandom(seed).next;
          const delivered: { streamId: number; id: number }[] = [];
          const resetOnServer = new Set<number>();
          pair.server.onReceive.subscribe((streamId, _ppId, data) => {
            if (data.length >= 4)
              delivered.push({ streamId, id: data.readUInt32BE(0) });
          });
          pair.server.onReconfigStreams.subscribe((ids) => {
            for (const id of ids) resetOnServer.add(id);
          });
          for (const streamId of STREAMS) {
            await pair.server.send(streamId, 51, Buffer.from("s"));
          }
          await flushImmediates();
          pair.recorder.dropIf = () => random() < LOSS_RATE;
          pair.serverRecorder.dropIf = () => random() < LOSS_RATE;

          // Act: 送信・reset・時間経過を乱数で織り交ぜる (reset した stream には以後送らない = DataChannel の close)
          const open = new Set(STREAMS);
          const resetRequested: number[] = [];
          const sent: { streamId: number; id: number }[] = [];
          for (let step = 0; step < 30; step++) {
            const streamId = [...open][Math.floor(random() * open.size)];
            if (streamId !== undefined && random() < 0.75) {
              const id = sent.length;
              const data = Buffer.alloc(16 + Math.floor(random() * 3_000), id);
              data.writeUInt32BE(id, 0);
              sent.push({ streamId, id });
              void pair.client.send(streamId, 53, data);
            } else if (streamId !== undefined) {
              open.delete(streamId);
              resetRequested.push(streamId);
              pair.client.reconfigQueue.push(streamId);
              void pair.client.transmitReconfigRequest();
            }
            await flushImmediates(3);
            await vi.advanceTimersByTimeAsync(Math.floor(random() * 1_500));
            await flushImmediates(3);
          }
          // Act: 損失を止め、両端の送信と再構成が片付くまで時間を進める
          pair.recorder.dropIf = undefined;
          pair.serverRecorder.dropIf = undefined;
          const busy = (sctp: any) =>
            outboundQueueOf(sctp).length > 0 ||
            sctp.sentQueue.length > 0 ||
            sctp.reconfigRequest !== undefined ||
            sctp.reconfigQueue.length > 0;
          for (
            let i = 0;
            i < 120 && (busy(pair.client) || busy(pair.server));
            i++
          ) {
            await vi.advanceTimersByTimeAsync(5_000);
            await flushImmediates();
          }

          // Assert: association は保たれ、両端の reset request がすべて完了している
          expect(pair.client.associationState).toBe(SCTP_STATE.ESTABLISHED);
          expect(pair.server.associationState).toBe(SCTP_STATE.ESTABLISHED);
          expect(busy(pair.client)).toBe(false);
          expect(busy(pair.server)).toBe(false);
          expect([...resetOnServer].sort()).toEqual(
            expect.arrayContaining([...resetRequested].sort()),
          );
          // Assert: 送ったメッセージはすべて 1 回ずつ、stream ごとに送信順で届く
          expect(delivered.map((d) => d.id).sort((a, b) => a - b)).toEqual(
            sent.map((m) => m.id),
          );
          for (const streamId of STREAMS) {
            const ids = delivered
              .filter((d) => d.streamId === streamId)
              .map((d) => d.id);
            expect(ids).toEqual(
              sent.filter((m) => m.streamId === streamId).map((m) => m.id),
            );
          }
        } finally {
          await pair.stop();
        }
      },
    );
  },
);
