import { setTimeout } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import {
  GccBandwidthEstimator,
  MediaStreamTrack,
  type RtpHeader,
  type RtpPacket,
  type SentInfo,
  kProbePaddingPacketBytes,
} from "../../../src";
import { attachPacedFifoEstimator, createRtpPacket } from "../../fixture";
import {
  prepareConnectedSender,
  startGccProbing,
} from "../../media/twccTestUtils";
import { seededRandom } from "../shared/random";
import { propertySeeds } from "../shared/seeds";
import { type ForwardStep, randomForwardScript } from "./generator";

/**
 * RTP sender property test: claims about `RTCRtpSender`'s send path for any
 * input a seed draws (`sender/generator.ts`), on the legacy direct path and
 * on the paced FIFO used by GCC.
 *
 * CI runs `WERIFT_SENDER_SEEDS` (default 12) seeds per property from
 * `WERIFT_SENDER_SEED` (default 1); `WERIFT_SENDER_STEPS` (default 300) is
 * the length of a forwarded stream. A failing title prints the replay
 * environment.
 */
const { seeds, steps, replay } = propertySeeds("WERIFT_SENDER", {
  seeds: 12,
  steps: 300,
});
const cases = seeds.map((seed) => ({
  seed,
  path: (seed % 2 === 1 ? "legacy" : "paced") as "legacy" | "paced",
}));
const title = (claim: string) =>
  `${claim}: seed $seed (replay: ${replay("$seed")})`;

/** Act: forward `script` through a connected sender on the given path. */
async function forward(script: ForwardStep[], path: "legacy" | "paced") {
  const { sender, sentPackets } = await prepareConnectedSender();
  if (path === "paced") {
    // GCC の送信 FIFO を使い、呼び出しごとに 1 件の loss padding を許す
    const gcc = attachPacedFifoEstimator(sender);
    gcc.pendingLossPaddingPackets = () => 1;
    Object.assign(gcc, {
      probePaddingPacketBytes: 100,
      probePaddingMaxBurst: 1,
    });
  }
  const epochs: Extract<ForwardStep, { type: "media" }>[][] = [[]];
  for (const step of script) {
    if (step.type === "switch") {
      await sender.replaceTrack(
        new MediaStreamTrack({ kind: "video", remote: true }),
      );
      epochs.push([]);
      continue;
    }
    if (step.type === "padding") {
      for (let i = 0; i < step.count; i++) {
        if (path === "paced") {
          await sender.maybeInjectLossPadding();
        } else {
          await (sender as any).sendRtpInternal(
            (sender as any).createPaddingRtpPacket(kProbePaddingPacketBytes),
            { injectProbePadding: false, isProbePadding: true },
          );
        }
      }
      continue;
    }
    const rtp = createRtpPacket(
      step.seq,
      step.seq * 100,
      step.forwardedPadding ? Buffer.alloc(0) : Buffer.from([step.payloadByte]),
    );
    if (step.forwardedPadding) {
      rtp.header.padding = true;
      rtp.header.paddingSize = 4;
    }
    // registerTrack の中継と同じ sendRtp を、キュー上限で落ちないよう 1 件ずつ待つ
    await sender.sendRtp(rtp);
    epochs.at(-1)!.push(step);
  }
  await setTimeout(20);
  sender.stop();
  return { sender, sentPackets, epochs };
}

describe("rtp sender property", () => {
  test.each(cases)(
    title(
      "forward ($path): media 番号は source の差を保ち、切替では連続し、padding は RTX の連番だけ",
    ),
    async ({ seed, path }) => {
      // Arrange: gap・並べ替え・重複・上流 padding-only・自前 padding・track 切替の混在列
      const script = randomForwardScript(seededRandom(seed), steps);

      // Act
      const { sender, sentPackets, epochs } = await forward(script, path);

      // Assert: 転送した packet はすべて media SSRC に出る（自前 padding は出ない）
      const media = sentPackets.filter((p) => p.header.ssrc === sender.ssrc);
      expect(media.length).toBe(epochs.flat().length);
      let cursor = 0;
      let prevLast: number | undefined;
      let lastOffset = 0;
      for (const inputs of epochs) {
        const outputs = media.slice(cursor, cursor + inputs.length);
        cursor += inputs.length;
        if (inputs.length === 0) continue;
        // Assert: epoch 内は「出力番号 − 入力番号」が一定で、padding で詰めたりずらしたりしない
        const offset =
          (outputs[0].header.sequenceNumber - inputs[0].seq) & 0xffff;
        outputs.forEach((p, i) => {
          expect((p.header.sequenceNumber - inputs[i].seq) & 0xffff).toBe(
            offset,
          );
          // Assert: padding-only は padding のまま、media は中身のまま中継する
          expect(p.header.padding).toBe(inputs[i].forwardedPadding);
          if (!inputs[i].forwardedPadding) {
            expect(p.payload[0]).toBe(inputs[i].payloadByte);
          }
        });
        // Assert: 切替直後の先頭は、直前の出力 + 1
        if (prevLast !== undefined) {
          expect(outputs[0].header.sequenceNumber).toBe(
            (prevLast + 1) & 0xffff,
          );
        }
        prevLast = outputs.at(-1)!.header.sequenceNumber;
        lastOffset = offset;
      }

      // Assert: 自前の padding は RTX SSRC / PT 97 だけで、RTX 番号は連番
      const rtx = sentPackets.filter((p) => p.header.ssrc === sender.rtxSsrc);
      const ownPadding = script.some((s) => s.type === "padding");
      if (ownPadding) expect(rtx.length).toBeGreaterThan(0);
      expect(
        rtx.every((p) => p.header.padding && p.header.payloadType === 97),
      ).toBe(true);
      for (let i = 1; i < rtx.length; i++) {
        expect(rtx[i].header.sequenceNumber).toBe(
          (rtx[i - 1].header.sequenceNumber + 1) & 0xffff,
        );
      }

      // Assert: NACK 用 cache（切替で空になる）は最後の epoch の各番号の最後の media を
      //         保持し、padding-only では上書きされない
      const lastBySlot = new Map<
        number,
        { wire: number; payloadByte: number }
      >();
      for (const s of epochs.at(-1)!) {
        if (s.forwardedPadding) continue;
        const wire = (s.seq + lastOffset) & 0xffff;
        lastBySlot.set(wire % 128, { wire, payloadByte: s.payloadByte });
      }
      const cache = (sender as any).rtpCache as RtpPacket[];
      for (const [slot, s] of lastBySlot) {
        expect(cache[slot]?.header.sequenceNumber).toBe(s.wire);
        expect(cache[slot]?.payload[0]).toBe(s.payloadByte);
      }
    },
  );

  test.each(cases.map(({ seed }) => ({ seed, probing: seed % 2 === 0 })))(
    title(
      "fifo (probe 中=$probing): 並行 sendRtp でも DTLS write は 1 本ずつで、TSN は送信順に連番",
    ),
    async ({ seed, probing }) => {
      // Arrange: GCC の送信 FIFO。DTLS 書き込みはランダムに遅延する
      const rng = seededRandom(seed);
      const gcc = new GccBandwidthEstimator(100_000);
      const { sender, dtls } = await prepareConnectedSender(gcc);
      if (probing) {
        // probe tag / cluster は残し、padding 注入だけ止める
        startGccProbing(gcc);
        vi.spyOn(gcc, "pendingProbePaddingPackets").mockReturnValue(0);
      } else {
        // 初期 probe を終えた状態にし、cluster event が media と重ならないようにする
        (gcc as any).probe.abort(0);
        (gcc as any).probe.state = "complete";
        (gcc as any).probingConfigured = true;
      }
      let inFlight = 0;
      let maxInFlight = 0;
      let mediaSent = 0;
      const wireTsns: number[] = [];
      dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        wireTsns.push(
          header.extensions.find((e) => e.id === 3)!.payload.readUInt16BE(0),
        );
        if (header.ssrc === sender.ssrc) mediaSent++;
        await setTimeout(rng.int(0, 6));
        inFlight--;
        return payload.length + header.serializeSize;
      }) as typeof dtls.sendRtp;
      const sentSeqs: number[] = [];
      const orig = gcc.rtpPacketSent.bind(gcc);
      gcc.rtpPacketSent = (info: SentInfo) => {
        sentSeqs.push(info.wideSeq);
        orig(info);
      };
      const count = rng.int(2, 8);

      // Act: 完了を待たずに count 件を投入する
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          sender.sendRtp(
            createRtpPacket(i + 1, (i + 1) * 100, Buffer.alloc(80)),
          ),
        ),
      );
      sender.stop();

      // Assert: 同時に DTLS へ渡すのは 1 本だけで、media は count 件すべて出る
      expect(maxInFlight).toBe(1);
      expect(mediaSent).toBe(count);
      // Assert: TSN は 1 から連番で、wire に出た順と SentInfo の順が一致する
      expect(sentSeqs).toEqual(
        Array.from({ length: sentSeqs.length }, (_, i) => i + 1),
      );
      expect(wireTsns).toEqual(sentSeqs);
    },
  );
});
