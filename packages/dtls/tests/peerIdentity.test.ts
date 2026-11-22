import { UdpTransport } from "../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../src";
import { resolvePeerIdentityMode } from "../src/peer";
import type { Options } from "../src/socket";
import { certPem, keyPem } from "./fixture";

/** Shared Arrange: a DTLS 1.2 server / client on a real UDP transport. */
async function arrangeSocket(
  kind: "server" | "client",
  options: Partial<Options> = {},
) {
  const transport = await UdpTransport.init("udp4");
  const socket =
    kind === "server"
      ? new DtlsServer({ transport, cert: certPem, key: keyPem, ...options })
      : new DtlsClient({ transport, cert: certPem, key: keyPem, ...options });
  return {
    socket: socket as any,
    close: async () => {
      socket.close();
      await transport.close().catch(() => {});
    },
  };
}

describe("peerIdentityMode の既定値", () => {
  test("DTLS 1.2 のみは unpinned、DTLS 1.3 を提示すると datagram-address になる", () => {
    // Act / Assert: 明示が無ければ DTLS 1.3 の提示で pin を opt-in する
    expect(resolvePeerIdentityMode({ offersDtls13: false })).toBe("unpinned");
    expect(resolvePeerIdentityMode({ offersDtls13: true })).toBe(
      "datagram-address",
    );
    // Act / Assert: DTLS 1.3 engine（offersDtls13 省略）は常に pin する
    expect(resolvePeerIdentityMode({})).toBe("datagram-address");
    // Act / Assert: ICE 認証済み transport と明示指定は DTLS 1.2 のみでも優先される
    expect(
      resolvePeerIdentityMode({
        offersDtls13: false,
        addressValidation: "ice-authenticated",
      }),
    ).toBe("authenticated-single-peer");
    expect(
      resolvePeerIdentityMode({
        offersDtls13: false,
        peerIdentityMode: "datagram-address",
      }),
    ).toBe("datagram-address");
  });

  test.each(["server", "client"] as const)(
    "既定の DTLS 1.2 %s はアドレスを pin せず、どの送信元も処理する",
    async (kind) => {
      // Arrange: protocolVersions も peerIdentityMode も指定しない
      const { socket, close } = await arrangeSocket(kind);
      try {
        // Act: association の pin を試みる
        socket.pinSendPeer(["127.0.0.1", 40000], "replace");

        // Assert: pin されず、別の送信元も association の peer として扱う
        expect(socket.peerIdentityMode).toBe("unpinned");
        expect(socket.transport.pinnedPeer).toBeUndefined();
        expect(socket.matchesPinnedPeer(["192.0.2.1", 1])).toBe(true);
        expect(socket.hasAssociationPeerAuth()).toBe(true);
      } finally {
        await close();
      }
    },
  );

  test.each(["server", "client"] as const)(
    "datagram-address を opt-in した DTLS 1.2 %s は pin 前の lifecycle を受け付けず、pin 後は別送信元を落とす",
    async (kind) => {
      // Arrange: アドレス pin を明示的に opt-in する
      const { socket, close } = await arrangeSocket(kind, {
        peerIdentityMode: "datagram-address",
      });
      try {
        // Assert: pin 前は client も server も peer 認証済みではない
        expect(socket.hasAssociationPeerAuth()).toBe(false);

        // Act: association の pin を設定する
        socket.pinSendPeer(["127.0.0.1", 40000], "replace");

        // Assert: pin した peer だけを受け付ける
        expect(socket.hasAssociationPeerAuth()).toBe(true);
        expect(socket.matchesPinnedPeer(["127.0.0.1", 40000])).toBe(true);
        expect(socket.matchesPinnedPeer(["192.0.2.1", 1])).toBe(false);
      } finally {
        await close();
      }
    },
  );

  test("DTLS 1.3 を提示する server は既定でアドレスを pin する", async () => {
    // Arrange: DTLS 1.3 / 1.2 を提示する
    const { socket, close } = await arrangeSocket("server", {
      protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
    });
    try {
      // Assert: DTLS 1.3 の提示で association pin が有効になる
      expect(socket.peerIdentityMode).toBe("datagram-address");
    } finally {
      await close();
    }
  });
});

describe("DTLS 1.2 の epoch 0 record の受理範囲", () => {
  test("自分の epoch が進んだ handshake 中は epoch 0 の alert だけを受け付け、接続後は受け付けない", async () => {
    // Arrange: client が Flight5 で ChangeCipherSpec を送った後（write epoch 1、未接続）
    const { socket, close } = await arrangeSocket("client");
    try {
      socket.dtls.epoch = 1;
      socket.connected = false;

      // Assert: 相手の平文 bad_certificate などの alert は受け付ける
      expect(socket.isAuthenticatedLegacy12Record(0, "alert")).toBe(true);
      // Assert: epoch 0 の handshake / application data は受け付けない
      expect(socket.isAuthenticatedLegacy12Record(0, "handshake")).toBe(false);
      expect(socket.isAuthenticatedLegacy12Record(0, "applicationData")).toBe(
        false,
      );
      // Assert: 暗号化された record は常に受け付ける
      expect(socket.isAuthenticatedLegacy12Record(1, "handshake")).toBe(true);

      // Act: 接続が完了する
      socket.connected = true;

      // Assert: 接続後は epoch 0 の alert も受け付けない
      expect(socket.isAuthenticatedLegacy12Record(0, "alert")).toBe(false);
    } finally {
      await close();
    }
  });

  test("鍵がまだ無い間は epoch 0 の record をすべて受け付ける", async () => {
    // Arrange: handshake 開始前（write epoch 0、未接続）
    const { socket, close } = await arrangeSocket("server");
    try {
      // Assert: epoch 0 の handshake / alert を受け付ける
      expect(socket.isAuthenticatedLegacy12Record(0, "handshake")).toBe(true);
      expect(socket.isAuthenticatedLegacy12Record(0, "alert")).toBe(true);
    } finally {
      await close();
    }
  });
});
