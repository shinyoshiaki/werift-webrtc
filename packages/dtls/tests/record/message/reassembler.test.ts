import { HandshakeType } from "../../../src/handshake/const";
import { ClientHello } from "../../../src/handshake/message/client/hello";
import { DtlsRandom } from "../../../src/handshake/random";
import { FragmentedHandshake } from "../../../src/record/message/fragment";
import { HandshakeReassembler } from "../../../src/record/message/reassembler";
import {
  addAllFragments,
  createLargeClientHelloHandshake,
  createPartialFragment,
  fragmentHandshake,
  sliceHandshake,
} from "../../utils";

// src/record/message/reassembler.ts の仕様。ソースのコメントはここのテスト名を参照する。
describe("record/message/reassembler", () => {
  const createHello = () =>
    createLargeClientHelloHandshake({ random: new DtlsRandom() });

  describe("reassembly", () => {
    test.each([
      ["last, middle, first", [2, 1, 0]],
      ["middle, last, first", [1, 2, 0]],
      ["first, last, middle", [0, 2, 1]],
    ])(
      "delivers a message only once every byte was received, as one fragment at offset 0 [%s]",
      (_, order) => {
        // Arrange
        const hello = createHello();
        const size = Math.ceil(hello.length / 3);
        const fragments = fragmentHandshake(hello, size, order);
        const reassembler = new HandshakeReassembler();

        // Act
        // 3 分割した ClientHello を指定順に投入する
        const results = addAllFragments(reassembler, fragments);

        // Assert
        // 最後の 1 個を入れるまでは何も返らない
        expect(fragments).toHaveLength(3);
        expect(results.slice(0, 2)).toEqual([undefined, undefined]);
        // 完成したメッセージは単一フラグメントで、シリアライズ結果まで元と一致する
        const assembled = results[2]!;
        expect(assembled.fragment_offset).toBe(0);
        expect(assembled.fragment_length).toBe(hello.length);
        expect(assembled.serialize()).toEqual(hello.serialize());
        expect(
          ClientHello.deSerialize(assembled.fragment).cipherSuites,
        ).toEqual(ClientHello.deSerialize(hello.fragment).cipherSuites);
        // バッファは解放されている
        expect(reassembler.size).toBe(0);
        expect(reassembler.bufferedBytes).toBe(0);
      },
    );

    test("does not deliver when the final fragment arrives while a gap remains", () => {
      // Arrange
      const hello = createHello();
      const [first, middle, last] = fragmentHandshake(
        hello,
        Math.ceil(hello.length / 3),
      );
      const reassembler = new HandshakeReassembler();

      // Act
      // 先頭が欠けたまま中間と末尾を投入し、その後で先頭を投入する
      const beforeGap = addAllFragments(reassembler, [middle, last]);
      const sizeWithGap = reassembler.size;
      const afterGap = reassembler.add(first);

      // Assert
      // 末尾が届いても欠落がある間は返らない
      expect(beforeGap).toEqual([undefined, undefined]);
      expect(sizeWithGap).toBe(1);
      // 欠落分が届いた時点で元と同じバイト列が返る
      expect(afterGap?.serialize()).toEqual(hello.serialize());
    });

    test("reassembles a large ClientHello split by the default MTU", () => {
      // Arrange
      const hello = createLargeClientHelloHandshake({
        random: new DtlsRandom(),
        keyShareLength: 3000,
      });
      const fragments = hello.chunk().reverse();
      const reassembler = new HandshakeReassembler();

      // Act
      // 既定 MTU で分割した大きな ClientHello を逆順に投入する
      const results = addAllFragments(reassembler, fragments);

      // Assert
      // 3 分割以上になり、最後の投入でだけ完全一致のメッセージが返る
      expect(fragments.length).toBeGreaterThanOrEqual(3);
      expect(results.slice(0, -1).every((r) => r === undefined)).toBe(true);
      expect(results.at(-1)?.serialize()).toEqual(hello.serialize());
    });

    test("delivers an unfragmented message, and each retransmission of it, as is", () => {
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

    test("accepts duplicate fragments and fragments split at other boundaries when the bytes match", () => {
      // Arrange
      const hello = createHello();
      const byTen = fragmentHandshake(hello, 10);
      const bySeven = fragmentHandshake(hello, 7);
      const reassembler = new HandshakeReassembler();

      // Act
      // 10 バイト分割の奇数番目、その重複、7 バイト分割（再送時の再分割）を混ぜて投入する
      const odd = byTen.filter((_, i) => i % 2 === 1);
      const partial = addAllFragments(reassembler, [...odd, ...odd]);
      const results = addAllFragments(reassembler, bySeven);

      // Assert
      // 重なりのバイトが一致するので受理され、全バイトがそろった時点で 1 件だけ返る
      expect(partial.every((r) => r === undefined)).toBe(true);
      const assembled = results.filter((r) => r !== undefined);
      expect(assembled).toHaveLength(1);
      expect(assembled[0]!.serialize()).toEqual(hello.serialize());
    });

    test("discards a partial message whose already received bytes would change", () => {
      // Arrange
      const hello = createHello();
      const half = Math.floor(hello.length / 2);
      const first = sliceHandshake(hello, 0, half + 10);
      const corrupted = Buffer.from(
        hello.fragment.subarray(half, hello.length),
      );
      corrupted[0] ^= 0xff;
      const conflicting = sliceHandshake(hello, half, hello.length, corrupted);
      const reassembler = new HandshakeReassembler();

      // Act
      // 重なり部分のバイトが食い違うフラグメントを投入し、その後で正しい全フラグメントを投入する
      const rejected = addAllFragments(reassembler, [first, conflicting]);
      const sizeAfterReject = reassembler.size;
      const retried = addAllFragments(
        reassembler,
        fragmentHandshake(hello, 100),
      );

      // Assert
      // 不一致のメッセージは返らずに破棄される
      expect(rejected).toEqual([undefined, undefined]);
      expect(sizeAfterReject).toBe(0);
      // 正しいフラグメントを送り直せば完成する
      expect(retried.at(-1)?.serialize()).toEqual(hello.serialize());
    });

    test("merges adjacent and overlapping ranges, so contiguous fragments count as one range", () => {
      // Arrange
      const hello = createHello();
      const reassembler = new HandshakeReassembler({ maxRangesPerMessage: 1 });
      const byTen = fragmentHandshake(hello, 10);
      const overlapping = sliceHandshake(hello, 5, 25);

      // Act
      // 区間数の上限を 1 にして、隣接するフラグメントと重なるフラグメントを先頭から順に投入する
      const results = addAllFragments(reassembler, [
        byTen[0],
        overlapping,
        ...byTen.slice(1),
      ]);

      // Assert
      // 隣接・重複する区間は 1 つにまとまるので上限で破棄されず、最後に完成する
      expect(results.slice(0, -1).every((r) => r === undefined)).toBe(true);
      expect(results.at(-1)?.serialize()).toEqual(hello.serialize());
    });

    test("keeps messages of distinct sequence, type and length apart", () => {
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
      const assembled = addAllFragments(reassembler, interleaved).filter(
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

    test("keeps fragments of distinct epochs apart", () => {
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
  });

  describe("invalid fragments", () => {
    test.each([
      [
        "drops a fragment beyond its message length",
        (hello: FragmentedHandshake) => {
          const fragment = sliceHandshake(
            hello,
            hello.length - 10,
            hello.length,
          );
          fragment.fragment_offset += 1;
          return fragment;
        },
      ],
      [
        "drops a truncated fragment",
        (hello: FragmentedHandshake) => {
          const fragment = sliceHandshake(hello, 0, 100);
          fragment.fragment = fragment.fragment.subarray(0, 50);
          return fragment;
        },
      ],
      [
        "drops a fragment of a message longer than maxMessageLength",
        () =>
          new FragmentedHandshake(
            HandshakeType.certificate_11,
            HandshakeReassembler.MaxMessageLength + 1,
            0,
            0,
            10,
            Buffer.alloc(10),
          ),
      ],
      [
        "ignores an empty fragment",
        (hello: FragmentedHandshake) => sliceHandshake(hello, 10, 10),
      ],
    ])("%s", (_, createFragment) => {
      // Arrange
      const fragment = createFragment(createHello());
      const reassembler = new HandshakeReassembler();

      // Act
      // 不正なフラグメントを投入する
      const result = reassembler.add(fragment);

      // Assert
      // 何も返らず、バッファも確保されない
      expect(result).toBeUndefined();
      expect(reassembler.size).toBe(0);
      expect(reassembler.bufferedBytes).toBe(0);
    });
  });

  describe("limits", () => {
    test("keeps at most maxEntries partial messages", () => {
      // Arrange
      const clock = { now: 0 };
      const reassembler = new HandshakeReassembler({
        maxEntries: 2,
        now: () => clock.now,
      });

      // Act
      // 上限 2 件のところに 3 件目の部分メッセージを投入する
      addAllFragments(reassembler, [
        createPartialFragment(clock, 0, 100),
        createPartialFragment(clock, 1, 100),
        createPartialFragment(clock, 2, 100),
      ]);

      // Assert
      // 保持数は上限を超えない
      expect(reassembler.size).toBe(2);
      expect(reassembler.bufferedBytes).toBe(200);
    });

    test("keeps at most maxBufferedBytes of partial messages", () => {
      // Arrange
      const clock = { now: 0 };
      const reassembler = new HandshakeReassembler({
        maxBufferedBytes: 250,
        now: () => clock.now,
      });

      // Act
      // 合計 250 バイトの上限に対して 100 + 100 + 200 バイトの部分メッセージを投入する
      addAllFragments(reassembler, [
        createPartialFragment(clock, 0, 100),
        createPartialFragment(clock, 1, 100),
        createPartialFragment(clock, 2, 200),
      ]);

      // Assert
      // 上限に収まるまで古いメッセージが捨てられ、最後のものだけ残る
      expect(reassembler.size).toBe(1);
      expect(reassembler.bufferedBytes).toBe(200);
    });

    test("drops a message longer than maxBufferedBytes on its own", () => {
      // Arrange
      const clock = { now: 0 };
      const reassembler = new HandshakeReassembler({
        maxBufferedBytes: 250,
        now: () => clock.now,
      });
      reassembler.add(createPartialFragment(clock, 0, 200));

      // Act
      // 単独で総バイト数上限を超える部分メッセージを投入する
      const result = reassembler.add(createPartialFragment(clock, 1, 251));

      // Assert
      // バッファされず、既存のメッセージも捨てられない
      expect(result).toBeUndefined();
      expect(reassembler.size).toBe(1);
      expect(reassembler.bufferedBytes).toBe(200);
    });

    test("evicts the least recently updated message first", () => {
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
      // A, B を投入して A を更新したあと C を投入し、A と B を完成させる
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

    test("discards a message split into more than maxRangesPerMessage ranges", () => {
      // Arrange
      const hello = createHello();
      const reassembler = new HandshakeReassembler({ maxRangesPerMessage: 3 });
      const everyOther = fragmentHandshake(hello, 10).filter(
        (_, i) => i % 2 === 0,
      );

      // Act
      // 隙間の空いたフラグメントを 4 個投入する
      addAllFragments(reassembler, everyOther.slice(0, 3));
      const sizeAtLimit = reassembler.size;
      addAllFragments(reassembler, everyOther.slice(3, 4));

      // Assert
      // 区間数が上限を超えたメッセージは破棄される
      expect(sizeAtLimit).toBe(1);
      expect(reassembler.size).toBe(0);
      expect(reassembler.bufferedBytes).toBe(0);
    });

    test("discards a partial message not updated for entryLifetimeMs", () => {
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
      // 古い部分バッファは捨てられているので完成せず、新しい部分メッセージだけが残る
      expect(result).toBeUndefined();
      expect(reassembler.size).toBe(1);
    });

    test("evaluates entryLifetimeMs only when the next fragment is added, not on a timer", () => {
      // Arrange
      const clock = { now: 0 };
      const reassembler = new HandshakeReassembler({
        entryLifetimeMs: 1000,
        now: () => clock.now,
      });
      reassembler.add(createPartialFragment(clock, 0, 100));

      // Act
      // 寿命を超えるまで何も投入せずに待ち、その後で別メッセージのフラグメントを投入する
      clock.now = 2000;
      const sizeWhileIdle = reassembler.size;
      reassembler.add(createPartialFragment(clock, 1, 50));

      // Assert
      // アイドル中は期限切れでも保持されたまま
      expect(sizeWhileIdle).toBe(1);
      // 次の投入時に期限切れのメッセージが捨てられる
      expect(reassembler.size).toBe(1);
      expect(reassembler.bufferedBytes).toBe(50);
    });

    test("clear() discards every partial message", () => {
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
});
