import { HandshakeType } from "../../../src/handshake/const";
import { ClientHello } from "../../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../../src/handshake/random";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { HandshakeReassembler } from "../../../src/record/message/reassembler";
import {
  createLargeClientHelloHandshake,
  fragmentHandshake,
  sliceHandshake,
} from "../../utils";

/** 全フラグメントを順に投入し、各投入の戻り値を返す */
const addAll = (
  reassembler: HandshakeReassembler,
  fragments: FragmentedHandshake[],
  epoch = 0,
) => fragments.map((fragment) => reassembler.add(fragment, epoch));

describe("record/message/reassembler", () => {
  const createHello = () =>
    createLargeClientHelloHandshake({ random: new DtlsRandom() });

  test.each([
    ["last, middle, first", [2, 1, 0]],
    ["middle, last, first", [1, 2, 0]],
    ["first, last, middle", [0, 2, 1]],
  ])("three fragments in order [%s]", (_, order) => {
    // Arrange
    const hello = createHello();
    const size = Math.ceil(hello.length / 3);
    const fragments = fragmentHandshake(hello, size, order);
    const reassembler = new HandshakeReassembler();

    // Act
    // 3 分割した ClientHello を指定順に投入する
    const results = addAll(reassembler, fragments);

    // Assert
    // 最後の 1 個を入れるまでは何も返らない
    expect(fragments).toHaveLength(3);
    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    // 完成したメッセージは単一フラグメントで、シリアライズ結果まで元と一致する
    const assembled = results[2]!;
    expect(assembled.fragment_offset).toBe(0);
    expect(assembled.fragment_length).toBe(hello.length);
    expect(assembled.serialize()).toEqual(hello.serialize());
    expect(ClientHello.deSerialize(assembled.fragment).cipherSuites).toEqual(
      ClientHello.deSerialize(hello.fragment).cipherSuites,
    );
    // バッファは解放されている
    expect(reassembler.size).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);
  });

  test("final fragment while a gap remains is not delivered", () => {
    // Arrange
    const hello = createHello();
    const [first, middle, last] = fragmentHandshake(
      hello,
      Math.ceil(hello.length / 3),
    );
    const reassembler = new HandshakeReassembler();

    // Act
    // 先頭が欠けたまま中間と末尾を投入し、その後で先頭を投入する
    const beforeGap = addAll(reassembler, [middle, last]);
    const sizeWithGap = reassembler.size;
    const afterGap = reassembler.add(first);

    // Assert
    // 末尾が届いても欠落がある間は返らない
    expect(beforeGap).toEqual([undefined, undefined]);
    expect(sizeWithGap).toBe(1);
    // 欠落分が届いた時点で元と同じバイト列が返る
    expect(afterGap?.serialize()).toEqual(hello.serialize());
  });

  test("large ClientHello split by the default MTU", () => {
    // Arrange
    const hello = createLargeClientHelloHandshake({
      random: new DtlsRandom(),
      keyShareLength: 3000,
    });
    const fragments = hello.chunk().reverse();
    const reassembler = new HandshakeReassembler();

    // Act
    // 既定 MTU で分割した大きな ClientHello を逆順に投入する
    const results = addAll(reassembler, fragments);

    // Assert
    // 3 分割以上になり、最後の投入でだけ完全一致のメッセージが返る
    expect(fragments.length).toBeGreaterThanOrEqual(3);
    expect(results.slice(0, -1).every((r) => r === undefined)).toBe(true);
    expect(results.at(-1)?.serialize()).toEqual(hello.serialize());
  });

  test("duplicate fragments and fragments split at other boundaries", () => {
    // Arrange
    const hello = createHello();
    const byTen = fragmentHandshake(hello, 10);
    const bySeven = fragmentHandshake(hello, 7);
    const reassembler = new HandshakeReassembler();

    // Act
    // 10 バイト分割の奇数番目、その重複、7 バイト分割（再送時の再分割）を混ぜて投入する
    const odd = byTen.filter((_, i) => i % 2 === 1);
    const partial = addAll(reassembler, [...odd, ...odd]);
    const results = addAll(reassembler, bySeven);

    // Assert
    // 重なりのバイトが一致するので受理され、全バイトがそろった時点で 1 件だけ返る
    expect(partial.every((r) => r === undefined)).toBe(true);
    const assembled = results.filter((r) => r !== undefined);
    expect(assembled).toHaveLength(1);
    expect(assembled[0]!.serialize()).toEqual(hello.serialize());
  });

  test("inconsistent overlapping bytes discard the message", () => {
    // Arrange
    const hello = createHello();
    const half = Math.floor(hello.length / 2);
    const first = sliceHandshake(hello, 0, half + 10);
    const corrupted = Buffer.from(hello.fragment.subarray(half, hello.length));
    corrupted[0] ^= 0xff;
    const conflicting = sliceHandshake(hello, half, hello.length, corrupted);
    const reassembler = new HandshakeReassembler();

    // Act
    // 重なり部分のバイトが食い違うフラグメントを投入し、その後で正しい全フラグメントを投入する
    const rejected = addAll(reassembler, [first, conflicting]);
    const sizeAfterReject = reassembler.size;
    const retried = addAll(reassembler, fragmentHandshake(hello, 100));

    // Assert
    // 不一致のメッセージは返らずに破棄される
    expect(rejected).toEqual([undefined, undefined]);
    expect(sizeAfterReject).toBe(0);
    // 正しいフラグメントを送り直せば完成する
    expect(retried.at(-1)?.serialize()).toEqual(hello.serialize());
  });

  test("interleaved messages of distinct sequence, type and length", () => {
    // Arrange
    const helloSeq0 = createHello();
    const helloSeq1 = createHello();
    helloSeq1.message_seq = 1;
    const certificate = new FragmentedHandshake(
      HandshakeType.certificate_11,
      helloSeq0.length,
      0,
      0,
      helloSeq0.length,
      Buffer.alloc(helloSeq0.length, 0xab),
    );
    const shorter = createLargeClientHelloHandshake({
      random: new DtlsRandom(),
      keyShareLength: 500,
    });
    const groups = [helloSeq0, helloSeq1, certificate, shorter].map((h) =>
      fragmentHandshake(h, 300).reverse(),
    );
    const interleaved: FragmentedHandshake[] = [];
    for (let i = 0; i < Math.max(...groups.map((g) => g.length)); i++) {
      for (const group of groups) if (group[i]) interleaved.push(group[i]);
    }
    const reassembler = new HandshakeReassembler();

    // Act
    // 4 つのメッセージのフラグメントを交互に投入する
    const assembled = addAll(reassembler, interleaved).filter(
      (r) => r !== undefined,
    );

    // Assert
    // それぞれが混ざらずに元と同じバイト列で組み立つ
    expect(assembled.map((a) => a!.serialize()).sort(Buffer.compare)).toEqual(
      [helloSeq0, helloSeq1, certificate, shorter]
        .map((h) => h.serialize())
        .sort(Buffer.compare),
    );
  });

  test("fragments of different epochs are not mixed", () => {
    // Arrange
    const hello = createHello();
    const [first, second] = fragmentHandshake(hello, hello.length - 10);
    const reassembler = new HandshakeReassembler();

    // Act
    // 同じメッセージの前半を epoch 0、後半を epoch 1 で投入する
    const results = [reassembler.add(first, 0), reassembler.add(second, 1)];

    // Assert
    // epoch が違うので組み立てられない
    expect(results).toEqual([undefined, undefined]);
    expect(reassembler.size).toBe(2);
  });

  test("unfragmented messages are delivered every time", () => {
    // Arrange
    const hello = createHello();
    const reassembler = new HandshakeReassembler();
    reassembler.add(sliceHandshake(hello, 0, 10));

    // Act
    // 部分受信中のメッセージの完全版と、その再送を投入する
    const results = [reassembler.add(hello), reassembler.add(hello)];

    // Assert
    // 未分割メッセージは再送も含めて毎回そのまま返り、部分バッファは破棄される
    expect(results).toEqual([hello, hello]);
    expect(reassembler.size).toBe(0);
  });

  test("invalid fragment headers are dropped", () => {
    // Arrange
    const hello = createHello();
    const outOfRange = sliceHandshake(hello, hello.length - 10, hello.length);
    outOfRange.fragment_offset += 1;
    const truncated = sliceHandshake(hello, 0, 100);
    truncated.fragment = truncated.fragment.subarray(0, 50);
    const tooLong = new FragmentedHandshake(
      HandshakeType.certificate_11,
      0x10000 + 1,
      0,
      0,
      10,
      Buffer.alloc(10),
    );
    const empty = sliceHandshake(hello, 10, 10);
    const reassembler = new HandshakeReassembler();

    // Act
    // 範囲外、長さ不一致、上限超過、空のフラグメントを投入する
    const results = addAll(reassembler, [
      outOfRange,
      truncated,
      tooLong,
      empty,
    ]);

    // Assert
    // どれも返らず、バッファも確保されない
    expect(results).toEqual([undefined, undefined, undefined, undefined]);
    expect(reassembler.size).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);
  });

  test("entry count and buffered bytes are bounded", () => {
    // Arrange
    let now = 0;
    const reassembler = new HandshakeReassembler({
      maxEntries: 2,
      maxBufferedBytes: 250,
      now: () => now,
    });
    const partial = (seq: number, length: number) => {
      now++;
      return new FragmentedHandshake(
        HandshakeType.certificate_11,
        length,
        seq,
        0,
        1,
        Buffer.alloc(1),
      );
    };

    // Act
    // 3 件目でエントリ数上限、4 件目で総バイト数上限を超えさせる
    reassembler.add(partial(0, 100));
    reassembler.add(partial(1, 100));
    reassembler.add(partial(2, 100));
    const sizeAfterCount = reassembler.size;
    reassembler.add(partial(3, 200));
    const tooLarge = reassembler.add(partial(4, 251));

    // Assert
    // 上限を超えないように古いエントリから捨てられる
    expect(sizeAfterCount).toBe(2);
    expect(reassembler.size).toBe(1);
    expect(reassembler.bufferedBytes).toBe(200);
    // 単独で総バイト数上限を超えるメッセージはバッファされない
    expect(tooLarge).toBeUndefined();
    expect(reassembler.bufferedBytes).toBe(200);
  });

  test("oldest entry is evicted first", () => {
    // Arrange
    let now = 0;
    const reassembler = new HandshakeReassembler({
      maxEntries: 2,
      now: () => now,
    });
    const helloA = createHello();
    const helloB = createHello();
    helloB.message_seq = 1;
    const helloC = createHello();
    helloC.message_seq = 2;

    // Act
    // A, B を投入して A を更新したあと C を投入し、A を完成させる
    reassembler.add(sliceHandshake(helloA, 0, 10));
    now = 1;
    reassembler.add(sliceHandshake(helloB, 0, 10));
    now = 2;
    reassembler.add(sliceHandshake(helloA, 10, 20));
    now = 3;
    reassembler.add(sliceHandshake(helloC, 0, 10));
    const completedA = reassembler.add(
      sliceHandshake(helloA, 20, helloA.length),
    );
    const completedB = reassembler.add(
      sliceHandshake(helloB, 10, helloB.length),
    );

    // Assert
    // 最後の更新が最も古い B が捨てられ、A は組み立つ
    expect(completedA?.serialize()).toEqual(helloA.serialize());
    expect(completedB).toBeUndefined();
  });

  test("ranges per message are bounded", () => {
    // Arrange
    const hello = createHello();
    const reassembler = new HandshakeReassembler({ maxRangesPerMessage: 3 });
    const everyOther = fragmentHandshake(hello, 10).filter(
      (_, i) => i % 2 === 0,
    );

    // Act
    // 隙間の空いたフラグメントを 4 個投入する
    addAll(reassembler, everyOther.slice(0, 3));
    const sizeAtLimit = reassembler.size;
    addAll(reassembler, everyOther.slice(3, 4));

    // Assert
    // 区間数が上限を超えたメッセージは破棄される
    expect(sizeAtLimit).toBe(1);
    expect(reassembler.size).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);
  });

  test("stale entries expire", () => {
    // Arrange
    let now = 0;
    const reassembler = new HandshakeReassembler({
      entryLifetimeMs: 1000,
      now: () => now,
    });
    const hello = createHello();
    reassembler.add(sliceHandshake(hello, 0, 10));

    // Act
    // 寿命を超えてから残りを投入する
    now = 1001;
    const result = reassembler.add(sliceHandshake(hello, 10, hello.length));

    // Assert
    // 古い部分バッファは捨てられているので完成しない
    expect(result).toBeUndefined();
    expect(reassembler.size).toBe(1);
  });

  test("clear discards partial messages", () => {
    // Arrange
    const hello = createHello();
    const reassembler = new HandshakeReassembler();
    reassembler.add(sliceHandshake(hello, 0, 10));

    // Act
    // 部分受信中にクリアする
    reassembler.clear();

    // Assert
    // バッファが空になる
    expect(reassembler.size).toBe(0);
    expect(reassembler.bufferedBytes).toBe(0);
  });
});
