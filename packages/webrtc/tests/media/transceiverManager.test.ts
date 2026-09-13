import {
  defaultPeerConfig,
  type PeerConfig,
  type RTCRtpTransceiver,
  TransceiverManager,
} from "../../src";
import { RtpRouter } from "../../src/media/router";
import { createDtlsTransport } from "../fixture";
import { createTransceiverManager } from "./transceiverManagerArrange";

describe("media/transceiverManager", () => {
  test("旧形式の第4引数 false では onTransceiverAdded を発火しない", () => {
    // Arrange: 公開 API の従来 boolean 形式を購読する
    const manager = createTransceiverManager();
    const added: RTCRtpTransceiver[] = [];
    manager.onTransceiverAdded.subscribe((transceiver) => {
      added.push(transceiver);
    });

    // Act: 旧形式で notify を抑止する
    const suppressed = manager.addTransceiver("audio", undefined, {}, false);

    // Assert: イベントは出さず、トランシーバー自体は追加される
    expect(added).toHaveLength(0);
    expect(manager.getTransceivers()).toEqual([suppressed]);
  });

  test("旧形式の第4引数 true では onTransceiverAdded を発火する", () => {
    // Arrange
    const manager = createTransceiverManager();
    const added: RTCRtpTransceiver[] = [];
    manager.onTransceiverAdded.subscribe((transceiver) => {
      added.push(transceiver);
    });

    // Act: 旧形式で明示的に通知する
    const notified = manager.addTransceiver("audio", undefined, {}, true);

    // Assert
    expect(added).toEqual([notified]);
  });

  test("オブジェクト形式の notify: false でもイベントを発火しない", () => {
    // Arrange
    const manager = createTransceiverManager();
    const added: RTCRtpTransceiver[] = [];
    manager.onTransceiverAdded.subscribe((transceiver) => {
      added.push(transceiver);
    });

    // Act
    manager.addTransceiver("audio", undefined, {}, { notify: false });

    // Assert
    expect(added).toHaveLength(0);
  });

  test("reuseInactiveMLine: false は inactive m-line を再利用しない", () => {
    // Arrange: 再利用候補になる inactive transceiver を先に置く
    const manager = createTransceiverManager();
    const inactive = manager.addTransceiver("audio");
    inactive.setCurrentDirection("inactive");
    inactive.mLineIndex = 0;
    inactive.mid = "0";

    // Act: リモート offer 相当で m-line 再利用を抑止する
    const created = manager.addTransceiver(
      "audio",
      undefined,
      { direction: "recvonly" },
      { reuseInactiveMLine: false },
    );

    // Assert: 既存 m-line を盗まず、別 transceiver として追加される
    expect(manager.getTransceivers()).toHaveLength(2);
    expect(created).not.toBe(inactive);
    expect(created.mid).toBeNull();
    expect(inactive.mid).toBe("0");
  });

  test("rebindTransportはsenderを新しいRTP sessionへ移す", () => {
    // Arrange: 独立transportに登録したsenderを用意する。
    const router = new RtpRouter();
    const manager = new TransceiverManager(
      "test-cname",
      defaultPeerConfig as Required<PeerConfig>,
      router,
    );
    const source = createDtlsTransport();
    const target = createDtlsTransport();
    const transceiver = manager.addTransceiver("video", source);
    const sender = transceiver.sender;
    expect(
      router.snapshotRtpSessions()[source.id]?.ssrcTable[sender.ssrc],
    ).toBe(sender);

    // Act: BUNDLE 相当の transport 差し替えを行う。
    manager.rebindTransport(transceiver, target);

    // Assert: 旧sessionから外れ、共有transportのssrcTableへ載る。
    expect(transceiver.dtlsTransport).toBe(target);
    expect(
      router.snapshotRtpSessions()[source.id]?.ssrcTable[sender.ssrc],
    ).toBeUndefined();
    expect(
      router.snapshotRtpSessions()[target.id]?.ssrcTable[sender.ssrc],
    ).toBe(sender);
  });
});
