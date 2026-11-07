import { RTCPeerConnection } from "../../src";

describe("datachannel/openLimit", () => {
  const long = "あ".repeat(21846);
  test.each(
    [false, true].flatMap((negotiated) => [
      { negotiated, name: "label", label: long, protocol: "" },
      { negotiated, name: "protocol", label: "ok", protocol: long },
    ]),
  )(
    "createDataChannel throws TypeError for an over-long $name (negotiated: $negotiated) and frees the ID",
    async ({ label, protocol, negotiated }) => {
      // Arrange: 接続前の PeerConnection を用意する。
      const pc = new RTCPeerConnection();
      const negotiationNeeded = vi.fn();
      pc.onNegotiationneeded.subscribe(negotiationNeeded);

      // Act: UTF-8 で 65535 バイトを超える値を ID 指定で作成する。
      const create = () =>
        pc.createDataChannel(label, { protocol, id: 42, negotiated });

      // Assert: W3C の要件どおり TypeError になる。
      expect(create).toThrow(TypeError);

      // Assert: SCTP transport も交渉予約も作られず、接続の状態が変わらない。
      expect(pc.sctpTransport).toBeUndefined();
      expect(pc.sctp).toBeNull();
      expect(pc.negotiationneeded).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      expect(negotiationNeeded).not.toHaveBeenCalled();

      // Act: 同じ ID で有効な値を使って作り直す。
      const retry = pc.createDataChannel("retry", { id: 42, negotiated });

      // Assert: ID が解放されており、作成に成功する。
      expect(retry.id).toBe(42);
      expect(retry.label).toBe("retry");

      await pc.close();
    },
  );
});
