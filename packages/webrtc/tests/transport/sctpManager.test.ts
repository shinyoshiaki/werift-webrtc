import { vi } from "vitest";

import { SCTP_STATE } from "../../../sctp/src";
import { Event } from "../../src/imports/common";
import { SctpTransportManager } from "../../src/sctpManager";

describe("SctpTransportManager", () => {
  test("closed association rejects connectSctp and permits a retry", async () => {
    // Arrange: SCTP 応答を返さない DTLS bridge を作る。
    const sendData = vi.fn(async () => {});
    const dtls = {
      id: "fake-dtls",
      role: "server",
      onStateChange: new Event<[string]>(),
      dataReceiver: () => {},
      sendData,
    } as any;
    const manager = new SctpTransportManager();
    const transport = manager.createSctpTransport();
    transport.setDtlsTransport(dtls);
    (manager as any).sctpRemotePort = 5001;

    // Act: association を COOKIE-WAIT まで進めて closed を通知する。
    const first = expect(manager.connectSctp()).rejects.toThrow(
      "SCTP association closed before connecting",
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);
    transport.sctp.setState(SCTP_STATE.CLOSED);
    await first;
    const failedAssociation = transport.sctp;

    // Assert: 失敗後の再試行は新 association を作り、closed で reject する。
    const second = expect(manager.connectSctp()).rejects.toThrow(
      "SCTP association closed before connecting",
    );
    expect(transport.sctp).not.toBe(failedAssociation);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.sctp.associationState).toBe(SCTP_STATE.COOKIE_WAIT);
    transport.sctp.setState(SCTP_STATE.CLOSED);
    await second;
  });
});
