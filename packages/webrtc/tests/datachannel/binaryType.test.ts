import { describe, expect, test } from "vitest";

import {
  type RTCDataChannelBinaryType,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
} from "../../src";
import {
  WEBRTC_BINARY,
  WEBRTC_BINARY_EMPTY,
  WEBRTC_STRING,
  WEBRTC_STRING_EMPTY,
} from "../../src/const";
import { installPolyfill } from "../../src/polyfill";
import {
  bytesOf,
  nextMessageOnEverySurface,
  openDataChannelPair,
  receiveRawMessage,
} from "./dataChannelTestUtils";

describe("datachannel/binaryType: defaults", () => {
  test.each<{
    name: string;
    config: RTCPeerConnectionConfig;
    expected: RTCDataChannelBinaryType;
  }>([
    { name: "core default", config: {}, expected: "nodebuffer" },
    {
      name: "dataChannelBinaryType: arraybuffer",
      config: { dataChannelBinaryType: "arraybuffer" },
      expected: "arraybuffer",
    },
    {
      name: "dataChannelBinaryType: blob",
      config: { dataChannelBinaryType: "blob" },
      expected: "blob",
    },
  ])(
    "$name applies to local and remote channels",
    async ({ config, expected }) => {
      // Act: config 付きの PeerConnection 同士でローカル作成・リモート作成の channel を開く
      const pair = await openDataChannelPair({ config });

      try {
        // Assert: どちらの channel も既定値を持ち、getConfiguration() に反映される
        expect(pair.local.binaryType).toBe(expected);
        expect(pair.remote.binaryType).toBe(expected);
        expect(pair.offerer.getConfiguration().dataChannelBinaryType).toBe(
          expected,
        );
      } finally {
        await pair.close();
      }
    },
  );

  test.each(["jellyfish", "", null, "Blob", "Standard"])(
    "an invalid dataChannelBinaryType %j is a TypeError",
    (value) => {
      // Act / Assert: 互換性オプションとして検証され TypeError になる
      expect(
        () => new RTCPeerConnection({ dataChannelBinaryType: value as never }),
      ).toThrow(
        new TypeError(
          "dataChannelBinaryType must be one of standard, nodebuffer, arraybuffer, blob",
        ),
      );
    },
  );

  test("dataChannelBinaryType: standard gives channels the W3C default arraybuffer", async () => {
    // Act: standard を指定した PeerConnection 同士でローカル作成・リモート作成の channel を開く
    const pair = await openDataChannelPair({
      config: { dataChannelBinaryType: "standard" },
    });

    try {
      // Assert: 設定値は standard のまま、channel の binaryType は W3C 既定の arraybuffer
      expect(pair.offerer.getConfiguration().dataChannelBinaryType).toBe(
        "standard",
      );
      expect(pair.local.binaryType).toBe("arraybuffer");
      expect(pair.remote.binaryType).toBe("arraybuffer");

      // Act: バイナリを送る
      const received = nextMessageOnEverySurface(pair.remote);
      pair.local.send(Buffer.from([1, 2, 3]));
      const { onmessage } = await received;

      // Assert: ArrayBuffer で届く
      expect(onmessage).toBeInstanceOf(ArrayBuffer);
    } finally {
      await pair.close();
    }
  });

  test("compatibility: standard makes data channels deliver ArrayBuffer unless dataChannelBinaryType is given", async () => {
    // Act: プリセットだけ / プリセットと明示値を指定して channel を作る
    const preset = new RTCPeerConnection({ compatibility: "standard" });
    const explicit = new RTCPeerConnection({
      compatibility: "standard",
      dataChannelBinaryType: "nodebuffer",
    });

    try {
      // Assert: プリセットは dataChannelBinaryType も standard にし、channel は arraybuffer になる
      expect(preset.getConfiguration().dataChannelBinaryType).toBe("standard");
      expect(preset.createDataChannel("preset").binaryType).toBe("arraybuffer");
      // Assert: 明示した値はプリセットより優先される
      expect(explicit.getConfiguration().dataChannelBinaryType).toBe(
        "nodebuffer",
      );
      expect(explicit.createDataChannel("explicit").binaryType).toBe(
        "nodebuffer",
      );

      // Act: プリセット付きでも setConfiguration() で変更できる
      preset.setConfiguration({ dataChannelBinaryType: "blob" });

      // Assert: 後から作る channel に効く
      expect(preset.createDataChannel("later").binaryType).toBe("blob");
    } finally {
      await Promise.all([preset.close(), explicit.close()]);
    }
  });

  test("setConfiguration() applies to channels created afterwards only", async () => {
    // Arrange: 既定 (nodebuffer) で開いた channel
    const pair = await openDataChannelPair();

    try {
      // Act: 両端の既定を arraybuffer に変え、新しい channel を作る
      pair.offerer.setConfiguration({ dataChannelBinaryType: "arraybuffer" });
      pair.answerer.setConfiguration({ dataChannelBinaryType: "arraybuffer" });
      const announced = new Promise<RTCDataChannelBinaryType>((resolve) => {
        pair.answerer.ondatachannel = ({ channel }) =>
          resolve(channel.binaryType);
      });
      const later = pair.offerer.createDataChannel("later");

      // Assert: 既存 channel は変わらず、後から作った channel (ローカル / リモート) だけに効く
      expect(pair.local.binaryType).toBe("nodebuffer");
      expect(pair.remote.binaryType).toBe("nodebuffer");
      expect(later.binaryType).toBe("arraybuffer");
      expect(await announced).toBe("arraybuffer");
      expect(pair.offerer.getConfiguration().dataChannelBinaryType).toBe(
        "arraybuffer",
      );
    } finally {
      await pair.close();
    }
  });

  test("werift/polyfill defaults to arraybuffer; install and constructor configurations win", async () => {
    // Arrange: 空の target に polyfill を 2 種類インストールする
    const plain: Record<string, any> = {};
    const configured: Record<string, any> = {};
    const uninstallPlain = installPolyfill({
      target: plain,
      mediaRegister: [],
    });
    const uninstallConfigured = installPolyfill({
      target: configured,
      mediaRegister: [],
      peerConnectionConfig: { dataChannelBinaryType: "blob" },
    });

    try {
      // Act: polyfill の RTCPeerConnection 同士で channel を開く
      const pair = await openDataChannelPair({
        create: (config) => new plain.RTCPeerConnection(config),
      });
      const install = new configured.RTCPeerConnection();
      const constructed = new plain.RTCPeerConnection({
        dataChannelBinaryType: "nodebuffer",
      });

      try {
        // Assert: polyfill 既定は W3C と同じ arraybuffer (ローカル・リモートとも)
        expect(pair.local.binaryType).toBe("arraybuffer");
        expect(pair.remote.binaryType).toBe("arraybuffer");
        // Assert: install config、コンストラクタ config の順に優先される
        expect(install.getConfiguration().dataChannelBinaryType).toBe("blob");
        expect(constructed.getConfiguration().dataChannelBinaryType).toBe(
          "nodebuffer",
        );
      } finally {
        await Promise.all([pair.close(), install.close(), constructed.close()]);
      }
    } finally {
      uninstallConfigured();
      uninstallPlain();
    }
  });
});

describe("datachannel/binaryType: setter", () => {
  test("the three values can be set and an invalid value is ignored (WPT RTCDataChannel-binaryType)", async () => {
    // Arrange: 交渉していない channel
    const pc = new RTCPeerConnection();
    const channel = pc.createDataChannel("setter");

    try {
      for (const valid of ["blob", "arraybuffer", "nodebuffer"] as const) {
        // Act: 有効値を設定する
        channel.binaryType = valid;
        // Assert: そのまま反映される
        expect(channel.binaryType).toBe(valid);
      }

      channel.binaryType = "arraybuffer";
      for (const invalid of [
        "jellyfish",
        "arraybuffer ",
        "",
        null,
        undefined,
        234,
        BigInt(1),
      ]) {
        // Act: 無効値を設定する
        channel.binaryType = invalid as never;
        // Assert: 例外にならず、前の値が保たれる
        expect(channel.binaryType).toBe("arraybuffer");
      }
    } finally {
      await pc.close();
    }
  });
});

type Pair = Awaited<ReturnType<typeof openDataChannelPair>>;

describe("datachannel/binaryType: received data", () => {
  // 空メッセージは RFC 8831 の PPID 57 / 56 (ペイロード 1 byte) で届く。
  // werift 自身は空メッセージを送らないため、受信経路へ直接渡す。
  const payloads = [
    {
      name: "binary",
      bytes: Buffer.from([0, 1, 2, 250, 255]),
      deliver: (pair: Pair) =>
        pair.local.send(Buffer.from([0, 1, 2, 250, 255])),
    },
    {
      name: "empty binary",
      bytes: Buffer.alloc(0),
      deliver: (pair: Pair) =>
        receiveRawMessage(pair.remote, WEBRTC_BINARY_EMPTY, Buffer.from([0])),
    },
    {
      name: "binary from the raw receive path",
      bytes: Buffer.from("raw"),
      deliver: (pair: Pair) =>
        receiveRawMessage(pair.remote, WEBRTC_BINARY, Buffer.from("raw")),
    },
  ];

  test.each(
    (["nodebuffer", "arraybuffer", "blob"] as const).flatMap((binaryType) =>
      payloads.map((payload) => ({ binaryType, ...payload })),
    ),
  )(
    "$binaryType: $name arrives byte for byte",
    async ({ binaryType, bytes, deliver }) => {
      // Arrange: 受信側の binaryType を設定した channel
      const pair = await openDataChannelPair();
      pair.remote.binaryType = binaryType;
      const received = nextMessageOnEverySurface(pair.remote);

      try {
        // Act: バイナリを届ける
        await deliver(pair);
        const { onMessage, onmessage, event } = await received;

        // Assert: onmessage と "message" には binaryType の型の同じオブジェクトが渡る
        expect(onmessage).toBe(event);
        const expectedType = {
          nodebuffer: Buffer,
          arraybuffer: ArrayBuffer,
          blob: Blob,
        }[binaryType];
        expect(onmessage).toBeInstanceOf(expectedType);
        // Assert: 内容はバイト一致し、ArrayBuffer は Buffer プールを共有しない (長さ一致)
        expect((await bytesOf(onmessage)).equals(bytes)).toBe(true);
        if (onmessage instanceof ArrayBuffer) {
          expect(onmessage.byteLength).toBe(bytes.length);
        }
        // Assert: onMessage は binaryType に関わらず Buffer
        expect(Buffer.isBuffer(onMessage)).toBe(true);
        expect((onMessage as Buffer).equals(bytes)).toBe(true);
      } finally {
        await pair.close();
      }
    },
  );

  test.each([
    { text: "hello", deliver: (pair: Pair) => pair.local.send("hello") },
    { text: "世界", deliver: (pair: Pair) => pair.local.send("世界") },
    {
      text: "",
      deliver: (pair: Pair) =>
        receiveRawMessage(pair.remote, WEBRTC_STRING_EMPTY, Buffer.from([0])),
    },
    {
      text: "raw",
      deliver: (pair: Pair) =>
        receiveRawMessage(pair.remote, WEBRTC_STRING, Buffer.from("raw")),
    },
  ])(
    "a text message $text is a string whatever the binaryType",
    async ({ text, deliver }) => {
      // Arrange: binaryType が blob の受信 channel
      const pair = await openDataChannelPair();
      pair.remote.binaryType = "blob";
      const received = nextMessageOnEverySurface(pair.remote);

      try {
        // Act: 文字列を届ける
        await deliver(pair);
        const { onMessage, onmessage, event } = await received;

        // Assert: どの通知面でも string のまま
        expect(onMessage).toBe(text);
        expect(onmessage).toBe(text);
        expect(event).toBe(text);
      } finally {
        await pair.close();
      }
    },
  );
});
