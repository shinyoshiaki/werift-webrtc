import { RTCPeerConnection } from "../../src";

describe("iceUseDefaultStunServer", () => {
  const stunOf = (pc: RTCPeerConnection) => (
    pc.addTransceiver("audio"), pc.iceTransports[0].connection.stunServer
  );

  test("既定ではデフォルト STUN サーバーにフォールバックする", () => {
    // Arrange / Act: iceServers を空にしてオプションは未指定
    const pc = new RTCPeerConnection({ iceServers: [] });

    // Assert: 組み込みの STUN サーバーが使われる
    expect(stunOf(pc)).toEqual(["stun.l.google.com", 19302]);
    return pc.close();
  });

  test("false で空の iceServers ではSTUNを使わない", () => {
    // Arrange / Act
    const pc = new RTCPeerConnection({
      iceServers: [],
      iceUseDefaultStunServer: false,
    });

    // Assert: STUN サーバーは未設定
    expect(stunOf(pc)).toBeUndefined();
    return pc.close();
  });

  test("false でも明示した STUN は使われ、TURN のみではSTUNなし", () => {
    // Arrange / Act
    const explicit = new RTCPeerConnection({
      iceServers: [{ urls: "stun:127.0.0.1:3478" }],
      iceUseDefaultStunServer: false,
    });
    const turnOnly = new RTCPeerConnection({
      iceServers: [
        { urls: "turn:127.0.0.1:3478", username: "u", credential: "p" },
      ],
      iceUseDefaultStunServer: false,
    });

    // Assert: 明示STUNのみ有効、TURNのみ構成ではSTUNなし
    expect(stunOf(explicit)).toEqual(["127.0.0.1", 3478]);
    expect(stunOf(turnOnly)).toBeUndefined();
    return Promise.all([explicit.close(), turnOnly.close()]);
  });
});
