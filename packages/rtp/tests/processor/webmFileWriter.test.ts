import { statSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { retryTransientFsError } from "../../src/extra/processor/fsRetry";
import type { WebmOutput } from "../../src/extra/processor/webm";
import { saveToFileSystem } from "../../src/extra/processor/webmCallback";
import { createWebmFileWriter } from "../../src/extra/processor/webmFileWriter";
import {
  collectWebmOutputs,
  createFaultInjectingFs,
  createWebmFileDir,
  createWebmFrames,
  type FsFaultOp,
  isFfprobeAvailable,
  probeWebmWarnings,
  readEbmlChildren,
  readEbmlElementHeader,
  saveWebmReference,
} from "../utils";

const ID = { segment: 0x18538067, cluster: 0x1f43b675, cues: 0x1c53bb6b };

describe("WebM file writer", () => {
  let outputs: WebmOutput[];
  let reference: Buffer;
  let dir: ReturnType<typeof createWebmFileDir>;
  let fs: ReturnType<typeof createFaultInjectingFs>;

  beforeEach(async () => {
    // Arrange (共通): 3 秒分の録画出力と、障害なしで保存した基準ファイル
    outputs = await collectWebmOutputs(createWebmFrames(3_000, 30));
    reference = await saveWebmReference(outputs);
    dir = createWebmFileDir();
    fs = createFaultInjectingFs();
  });

  afterEach(() => {
    dir.cleanup();
  });

  const createWriter = () =>
    createWebmFileWriter(dir.path("out.webm"), {
      open: fs.open,
      sleep: fs.sleep,
    });

  test("normal path never waits and matches positions", async () => {
    // Arrange
    const save = createWriter();

    // Act: 障害なしで全出力を保存する
    for (const output of outputs) {
      await save(output);
    }

    // Assert: 基準とバイト一致し、待機は一度も発生しない
    expect(dir.read("out.webm").equals(reference)).toBe(true);
    expect(fs.stats.sleeps).toEqual([]);
    // Assert: open と close は出力ごとに 1 回ずつ
    expect(fs.stats.opens).toBe(outputs.length);
    expect(fs.stats.closes).toBe(outputs.length);
  });

  test.each<FsFaultOp>(["open", "write", "close"])(
    "recovers from EBUSY on %s of every chunk and eol",
    async (op) => {
      // Arrange
      const save = createWriter();

      // Act: 各出力の直前に、op が 2 回 EBUSY を返すよう仕掛けて保存する
      for (const output of outputs) {
        fs.arm(op, "EBUSY", 2);
        await save(output);
      }

      // Assert: 障害なしの保存結果とバイト一致する
      expect(dir.read("out.webm").equals(reference)).toBe(true);
      // Assert: 出力ごとに 2 回だけ短い待機をした
      expect(fs.stats.sleeps).toEqual(outputs.flatMap(() => [20, 40]));
      // Assert: open したハンドルはすべて close された
      expect(fs.stats.closes).toBe(fs.stats.opens);
    },
  );

  test("close EBUSY after a full write does not append the chunk twice", async () => {
    // Arrange
    const save = createWriter();
    const sizes: number[] = [];

    // Act: 全バイト書けた後の close を EBUSY にして、出力ごとのファイルサイズを記録する
    for (const output of outputs.filter((o) => o.saveToFile)) {
      fs.arm("close", "EBUSY", 1);
      await save(output);
      sizes.push(statSync(dir.path("out.webm")).size);
    }

    // Assert: ファイルサイズは常に「chunk の位置 + 長さ」で、重複追記がない
    expect(sizes).toEqual(
      outputs
        .filter((o) => o.saveToFile)
        .map((o) => o.position! + o.saveToFile!.length),
    );
  });

  test("recovers from EBUSY after a partial write", async () => {
    // Arrange
    const save = createWriter();

    // Act: 各出力で、要求の半分だけ書いてから EBUSY を返す write を仕掛ける
    for (const output of outputs) {
      fs.arm("write", "EBUSY", 1, true);
      await save(output);
    }

    // Assert: 再試行後のファイルは基準とバイト一致する
    expect(dir.read("out.webm").equals(reference)).toBe(true);
    expect(fs.stats.closes).toBe(fs.stats.opens);
  });

  test("eol rewrite recovers from EBUSY and keeps the metadata valid", async () => {
    // Arrange
    const save = createWriter();
    const eol = outputs.at(-1)!;
    expect(eol.eol).toBeDefined();
    for (const output of outputs.slice(0, -1)) {
      await save(output);
    }

    // Act: eol の書き換え中の write (部分書き込み) と truncate を EBUSY にする
    fs.arm("write", "EBUSY", 3, true);
    fs.arm("truncate", "EBUSY", 1);
    const ended = await save(eol);
    const buf = dir.read("out.webm");

    // Assert: eol が報告され、基準とバイト一致する
    expect(ended).toBe(true);
    expect(buf.equals(reference)).toBe(true);
    // Assert: Segment はファイル末尾で終わり、Cluster → Cues と辿れる
    const [ebml] = readEbmlChildren(buf, {
      id: 0,
      position: 0,
      dataPosition: 0,
      size: buf.length,
    });
    const segment = readEbmlElementHeader(buf, ebml.dataPosition + ebml.size!);
    expect(segment.id).toBe(ID.segment);
    expect(segment.dataPosition + segment.size!).toBe(buf.length);
    const children = readEbmlChildren(buf, segment);
    expect(children.filter((c) => c.id === ID.cluster).length).toBe(4);
    expect(children.at(-1)!.id).toBe(ID.cues);
    // Assert: 試行ごとに close された
    expect(fs.stats.closes).toBe(fs.stats.opens);
  });

  test("gives up after the attempt limit and throws the last error", async () => {
    // Arrange
    const save = createWriter();

    // Act: open が常に EBUSY を返す
    fs.arm("open", "EBUSY", Infinity);
    const error = await save(outputs[0]).catch((e) => e);

    // Assert: 最後のエラーが code ごと伝わる
    expect(error.code).toBe("EBUSY");
    // Assert: 試行は 8 回 (待機 7 回) で、総待ち時間は 1 秒以内
    expect(fs.stats.sleeps.length).toBe(7);
    expect(fs.stats.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      1000,
    );
  });

  test.each(["EACCES", "ENOSPC", "EPERM"])(
    "fails at once on %s without retrying",
    async (code) => {
      // Arrange
      const save = createWriter();
      await save(outputs[0]);

      // Act: 次の chunk の write が恒久エラーを返す
      fs.arm("write", code, 1);
      const error = await save(outputs[1]).catch((e) => e);

      // Assert: 再試行せず 1 回で失敗し、待機もしない
      expect(error.code).toBe(code);
      expect(fs.stats.opens).toBe(2);
      expect(fs.stats.sleeps).toEqual([]);
      // Assert: 失敗した試行のハンドルも close された
      expect(fs.stats.closes).toBe(fs.stats.opens);
    },
  );

  test("the body error wins over a close error", async () => {
    // Arrange
    const save = createWriter();

    // Act: write が EACCES で失敗し、続く close も EBUSY で失敗する
    fs.arm("write", "EACCES", 1);
    fs.arm("close", "EBUSY", 1);
    const error = await save(outputs[0]).catch((e) => e);

    // Assert: 本体のエラーが throw され、close は 1 回だけ呼ばれる
    expect(error.code).toBe("EACCES");
    expect(fs.stats.opens).toBe(1);
    expect(fs.stats.closes).toBe(1);
  });

  test("writes nothing more after a failure", async () => {
    // Arrange
    const save = createWriter();
    await save(outputs[0]);
    fs.arm("open", "EACCES", 1);
    await save(outputs[1]).catch((e) => e);
    const size = statSync(dir.path("out.webm")).size;

    // Act: 失敗後に次の出力を保存しようとする
    const error = await save(outputs[2]).catch((e) => e);

    // Assert: 最初のエラーで拒否され、ファイルは変わらない
    expect(error.code).toBe("EACCES");
    expect(statSync(dir.path("out.webm")).size).toBe(size);
  });

  test("the first chunk replaces an existing file", async () => {
    // Arrange: 録画より大きい古いファイルがある
    writeFileSync(dir.path("out.webm"), Buffer.alloc(reference.length * 2, 7));
    const save = saveToFileSystem(dir.path("out.webm"));

    // Act
    for (const output of outputs) {
      await save(output);
    }

    // Assert: 古い内容は残らず、基準とバイト一致する
    expect(dir.read("out.webm").equals(reference)).toBe(true);
  });

  test("a writer created per output still saves a valid file", async () => {
    // Arrange: 既存ファイルがあり、従来どおり出力ごとに saver を作り直す
    writeFileSync(dir.path("out.webm"), "OLD-CONTENT");

    // Act
    for (const output of outputs) {
      await saveToFileSystem(dir.path("out.webm"))(output);
    }

    // Assert: position に従って書かれ、基準とバイト一致する
    expect(dir.read("out.webm").equals(reference)).toBe(true);
  });

  test("a writer created per output appends outputs without a position", async () => {
    // Arrange: position を持たない (独自に組み立てた) 出力
    const legacy = outputs.map(({ position: _, ...rest }) => rest);

    // Act
    for (const output of legacy) {
      await saveToFileSystem(dir.path("out.webm"))(output);
    }

    // Assert: 末尾への追記と eol の書き換えで基準と一致する
    expect(dir.read("out.webm").equals(reference)).toBe(true);
  });

  test.skipIf(!isFfprobeAvailable())(
    "ffprobe reads a file saved through injected faults without container warnings",
    async () => {
      // Arrange
      const save = createWriter();

      // Act: 部分書き込みと close の EBUSY を交互に仕掛けて保存する
      for (const [i, output] of outputs.entries()) {
        if (i % 2 === 0) {
          fs.arm("write", "EBUSY", 1, true);
        } else {
          fs.arm("close", "EBUSY", 1);
        }
        await save(output);
      }
      const warnings = probeWebmWarnings(dir.read("out.webm"));

      // Assert: コンテナ (matroska demuxer) の警告が出ない
      // (合成 VP8 フレームに対するデコーダの警告は対象外)
      expect(warnings).not.toContain("Unknown-sized element");
      expect(warnings).not.toMatch(/matroska/i);
    },
  );
});

describe("retryTransientFsError", () => {
  test("retries only what isTransient accepts", async () => {
    // Arrange
    const sleeps: number[] = [];
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) {
        throw Object.assign(new Error("again"), { code: "EAGAIN" });
      }
      return "ok";
    };

    // Act: EAGAIN を一時エラーとして注入した判定で実行する
    const result = await retryTransientFsError(op, {
      isTransient: (e) => (e as NodeJS.ErrnoException).code === "EAGAIN",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    // Assert: 2 回再試行して成功する
    expect(result).toBe("ok");
    expect(sleeps).toEqual([20, 40]);
  });

  test("does not retry EAGAIN by default", async () => {
    // Arrange
    let calls = 0;
    const op = async () => {
      calls++;
      throw Object.assign(new Error("again"), { code: "EAGAIN" });
    };

    // Act
    const error = await retryTransientFsError(op).catch((e) => e);

    // Assert: 既定では EBUSY 以外を再試行しない
    expect(error.code).toBe("EAGAIN");
    expect(calls).toBe(1);
  });
});
