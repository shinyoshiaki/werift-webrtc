import { RTCPeerConnection } from "../../src";

describe("datachannel/openLimit", () => {
  test.each([
    { name: "label", label: "あ".repeat(21846), protocol: "" },
    { name: "protocol", label: "ok", protocol: "あ".repeat(21846) },
  ])(
    "createDataChannel throws TypeError for an over-long $name and frees the ID",
    async ({ label, protocol }) => {
      // Arrange: 接続前の PeerConnection を用意する。
      const pc = new RTCPeerConnection();

      // Act: UTF-8 で 65535 バイトを超える値を ID 指定で作成する。
      const create = () => pc.createDataChannel(label, { protocol, id: 42 });

      // Assert: W3C の要件どおり TypeError になる。
      expect(create).toThrow(TypeError);

      // Act: 同じ ID で有効な値を使って作り直す。
      const retry = pc.createDataChannel("retry", { id: 42 });

      // Assert: ID が解放されており、作成に成功する。
      expect(retry.id).toBe(42);
      expect(retry.label).toBe("retry");

      await pc.close();
    },
  );
});
