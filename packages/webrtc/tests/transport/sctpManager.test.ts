import { vi } from "vitest";

import { SCTP_STATE } from "../../../sctp/src";
import { Event } from "../../src/imports/common";
import { SctpTransportManager } from "../../src/sctpManager";

describe("SctpTransportManager", () => {
  test("INIT failure consumes the CLOSED outcome rejection", async () => {
    // Arrange: SCTP INIT の送信を失敗させ、同時に association が CLOSED 通知を出す bridge を作る。
    const sendData = vi
      .fn<(...args: [Buffer]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("INIT send failed"));
    const dtls = {
      id: "fake-dtls-init-failure",
      role: "server",
      onStateChange: new Event<[string]>(),
      dataReceiver: () => {},
      sendData,
    } as any;
    const manager = new SctpTransportManager();
    const transport = manager.createSctpTransport();
    transport.setDtlsTransport(dtls);
    (manager as any).sctpRemotePort = 5001;

    // Act: start failure と CLOSED outcome の両方を処理し、呼び出し元へ元のエラーを返す。
    await expect(manager.connectSctp()).rejects.toThrow("INIT send failed");

    // Assert: 失敗 association は CLOSED で、未処理 rejection を残さない。
    expect(transport.sctp.associationState).toBe(SCTP_STATE.CLOSED);
    expect(sendData).toHaveBeenCalledTimes(1);
  });

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

  test("nextLocalPort wraps and skips 0", () => {
    // Assert: 次portは現行+1で、65535の次は5000へ戻る。
    expect(SctpTransportManager.nextLocalPort(5000)).toBe(5001);
    expect(SctpTransportManager.nextLocalPort(65535)).toBe(5000);
    expect(SctpTransportManager.nextLocalPort(undefined)).toBe(5001);
  });
});
