import { describe, expect, test } from "vitest";

import { RTCPeerConnection } from "../../src";
import type { SecureTransportManager } from "../../src/secureTransportManager";

/** Arrange: a peer and its SecureTransportManager (internal). */
function createPeer() {
  const pc = new RTCPeerConnection();
  const manager = (pc as unknown as { secureManager: SecureTransportManager })
    .secureManager;
  const owned = () =>
    (manager as unknown as { ownedTransports: Set<unknown> }).ownedTransports;
  return { pc, manager, owned };
}

describe("SecureTransportManager transport ownership", () => {
  test("close() stops a transport no m-line references any more", async () => {
    // Arrange: transceiver と、どの m-line・交渉にも参照されない transport (BUNDLE で外れたもの相当) を作り、gather させる。
    const { pc, manager } = createPeer();
    pc.addTransceiver("audio");
    const orphan = manager.createTransport({ inheritCredentials: false });
    await orphan.iceTransport.gather();
    expect(pc.dtlsTransports).not.toContain(orphan);

    // Act: peer connection を閉じる。
    await pc.close();

    // Assert: 参照されていない transport も DTLS / ICE とも閉じる。
    expect(orphan.state).toEqual("closed");
    expect(orphan.iceTransport.state).toEqual("closed");
  });

  test("a transport leaves the owned set once it closes", async () => {
    // Arrange: transport を 1 つ作る。
    const { pc, manager, owned } = createPeer();
    const transport = manager.createTransport({ inheritCredentials: false });
    expect(owned().has(transport)).toEqual(true);

    // Act: close() を待たずに transport を止める (交渉による退役と同じ)。
    await transport.stop();

    // Assert: 所有集合から外れ、再交渉を繰り返しても集合は増え続けない。
    expect(owned().has(transport)).toEqual(false);
    await pc.close();
  });

  test("an owned transport stays out of the live transports", async () => {
    // Arrange: transceiver を 1 つ持つ peer。
    const { pc, manager } = createPeer();
    const transceiver = pc.addTransceiver("audio");

    // Act: どの m-line も使わない transport を作る。
    manager.createTransport({ inheritCredentials: false });

    // Assert: live な transport (公開 getter と ICE 状態の集計対象) は transceiver のものだけ。
    expect(pc.dtlsTransports).toEqual([transceiver.dtlsTransport]);
    expect(pc.iceTransports).toEqual([transceiver.dtlsTransport.iceTransport]);
    await pc.close();
  });

  test("a transport whose DTLS closed by alert is still stopped by close()", async () => {
    // Arrange: gather 済みで、どの m-line にも参照されない transport。
    const { pc, manager, owned } = createPeer();
    pc.addTransceiver("audio");
    const orphan = manager.createTransport({ inheritCredentials: false });
    await orphan.iceTransport.gather();

    // Act: 受信 alert 相当で DTLS だけ closed にしてから pc を閉じる。
    (orphan as unknown as { setState(s: string): void }).setState("closed");
    expect(orphan.iceTransport.state).not.toEqual("closed");
    expect(owned().has(orphan)).toEqual(true);
    await pc.close();

    // Assert: ICE も止まり、所有集合も空になる。
    expect(orphan.iceTransport.state).toEqual("closed");
    expect(owned().size).toEqual(0);
  });

  test("close() waits for a stop that is already in progress", async () => {
    // Arrange: gather 済みで参照されない transport と、始まったままの stop()。
    const { pc, manager, owned } = createPeer();
    const orphan = manager.createTransport({ inheritCredentials: false });
    await orphan.iceTransport.gather();
    const inFlight = orphan.stop();
    expect(owned().has(orphan)).toEqual(true);

    // Act: stop の完了を待たずに pc を閉じる。
    await pc.close();

    // Assert: close() 完了時点で ICE の停止まで終わっている。
    expect(orphan.iceTransport.state).toEqual("closed");
    expect(owned().size).toEqual(0);
    await inFlight;
  });
});
