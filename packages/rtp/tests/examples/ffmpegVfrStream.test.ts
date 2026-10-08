import { Vp8RtpPayload } from "../../src/codec/vp8";
import { createRtpUdpCollector, runExample } from "../utils";

const EXAMPLE = "examples/node/pacer/ffmpeg-vfr-stream.ts";
const DURATION_SEC = 4;
const CLOCK_RATE = 90_000;

/** フレーム番号 n (30fps の入力) のうち、example の select フィルタが残すもの */
const expectedSourceFrames = Array.from(
  { length: DURATION_SEC * 30 },
  (_, n) => n,
).filter((n) => n % 60 < 30 || n % 3 === 0);

/** ソースが実時間に追いついていたとみなす最大 lateness (timer ジッタの範囲) */
const SOURCE_KEPT_UP_LATENESS_MS = 50;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** example 終了時の `done frames=N maxLateness=Xms delay=Yms` を読む */
const parseSummary = (stdout: string) => {
  const match = stdout.match(
    /done frames=(\d+) maxLateness=([\d.]+)ms delay=([\d.]+)ms/,
  );
  expect(match).not.toBeNull();
  return {
    frames: Number(match![1]),
    maxLateness: Number(match![2]),
    delay: Number(match![3]),
  };
};

describe("examples/node/pacer/ffmpeg-vfr-stream.ts", () => {
  test("ffmpeg のライブ VFR VP8 を pts 通りの RTP として欠落なく送出する", async () => {
    // Arrange: example の送信先になる UDP 受信ソケット
    const collector = await createRtpUdpCollector();

    try {
      // Act: example を別プロセスで実行し、終了まで待つ
      const result = await runExample(EXAMPLE, {
        env: {
          DEST_PORT: String(collector.port),
          DURATION_SEC: String(DURATION_SEC),
        },
      });

      // Assert: 正常終了し、送信ログと全フレーム送出の要約が出ている
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("send frame=0 ");
      const summary = parseSummary(result.stdout);
      expect(summary.frames).toBe(expectedSourceFrames.length);

      // Assert: seq は 1 ずつ連続し、パケット欠落がない
      const packets = collector.packets;
      packets.slice(1).forEach(({ rtp }, i) => {
        expect(rtp.header.sequenceNumber).toBe(
          (packets[i].rtp.header.sequenceNumber + 1) & 0xffff,
        );
      });
      // Assert: 全パケットが PT 96 / 同一 SSRC
      expect(new Set(packets.map((p) => p.rtp.header.payloadType))).toEqual(
        new Set([96]),
      );
      expect(new Set(packets.map((p) => p.rtp.header.ssrc)).size).toBe(1);

      // 1 フレーム = marker 付きパケットで終わる同一 timestamp のパケット列
      const frames: { timestamp: number; at: number; firstPayload: Buffer }[] =
        [];
      let firstPayload: Buffer | undefined;
      for (const { rtp, at } of packets) {
        firstPayload ??= rtp.payload;
        if (rtp.header.marker) {
          frames.push({ timestamp: rtp.header.timestamp, at, firstPayload });
          firstPayload = undefined;
        }
      }

      // Assert: select で残る全フレームが届き、途中で切れたフレームもない
      expect(frames).toHaveLength(expectedSourceFrames.length);
      expect(firstPayload).toBeUndefined();
      // Assert: 先頭フレームは VP8 キーフレームで、各フレーム先頭に S bit がある
      expect(Vp8RtpPayload.deSerialize(frames[0].firstPayload).isKeyframe).toBe(
        true,
      );
      expect(frames.every((f) => (f.firstPayload[0] & 0x10) !== 0)).toBe(true);

      // Assert: timestamp 差は入力の pts 差 (30fps 区間 3000 / 10fps 区間 9000) と一致する
      const tsDeltas = frames
        .slice(1)
        .map((f, i) => (f.timestamp - frames[i].timestamp) >>> 0);
      const expectedDeltas = expectedSourceFrames
        .slice(1)
        .map((n, i) => (n - expectedSourceFrames[i]) * 3000);
      expect(tsDeltas).toEqual(expectedDeltas);

      // Assert: どのフレームも pts の予定時刻より早くは届かない (まとめ送りしない)
      frames.forEach((f, i) => {
        const scheduledMs =
          (((f.timestamp - frames[0].timestamp) >>> 0) * 1000) / CLOCK_RATE;
        expect(f.at - frames[0].at).toBeGreaterThan(scheduledMs - 30);
      });

      if (summary.maxLateness >= SOURCE_KEPT_UP_LATENESS_MS) {
        // CPU 不足で ffmpeg が実時間でエンコードできなかった場合、フレームは到着次第送られるので
        // 送出間隔の精度は検証できない (pacer ではなくソース側の遅れ)
        console.warn(
          `ffmpeg fell behind real time (maxLateness=${summary.maxLateness}ms); skipped pacing accuracy checks`,
        );
        return;
      }

      // Assert: 到着間隔は timestamp 差に追従する (ジッタは中央値 5ms 未満)
      const arrivalErrors = frames
        .slice(1)
        .map((f, i) =>
          Math.abs(f.at - frames[i].at - (tsDeltas[i] * 1000) / CLOCK_RATE),
        );
      expect(median(arrivalErrors)).toBeLessThan(5);
      // Assert: 30fps 区間と 10fps 区間の送出間隔の違いが実時間に現れる
      const intervals = (delta: number) =>
        frames
          .slice(1)
          .map((f, i) => f.at - frames[i].at)
          .filter((_, i) => tsDeltas[i] === delta);
      expect(median(intervals(3000))).toBeLessThan(50);
      expect(median(intervals(9000))).toBeGreaterThan(80);
      // Assert: 全体の送出時間はメディア時間に一致する (ドリフトしない)
      const mediaMs =
        (((frames.at(-1)!.timestamp - frames[0].timestamp) >>> 0) * 1000) /
        CLOCK_RATE;
      expect(Math.abs(frames.at(-1)!.at - frames[0].at - mediaMs)).toBeLessThan(
        200,
      );
    } finally {
      await collector.close();
    }
  }, 60_000);

  test("DEST_PORT 未指定ではローカル受信側が timestamp 差と到着間隔を表示する", async () => {
    // Act: 受信側を内蔵したモードで 2 秒分だけ実行する
    const result = await runExample(EXAMPLE, {
      env: { DURATION_SEC: "2" },
    });

    // Assert: 正常終了し、全 40 フレームを送った要約が出る
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(parseSummary(result.stdout).frames).toBe(30 + 10);
    // Assert: 2 フレーム目以降の全フレームについて受信ログが出る
    const recv = [
      ...result.stdout.matchAll(/recv seq=\d+ tsDelta=([\d.]+)ms/g),
    ].map((m) => m[1]);
    expect(recv).toHaveLength(30 + 10 - 1);
    // Assert: 30fps (33.3ms) と 10fps (100.0ms) の両方の間隔が現れる
    expect(new Set(recv)).toEqual(new Set(["33.3", "100.0"]));
  }, 60_000);
});
