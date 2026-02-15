import { setTimeout as delay } from "timers/promises";
import { describe, expect, test, vi } from "vitest";

import {
  SCTP,
  SCTP_STATE,
  WEBRTC_PPID,
  createUdpTransport,
  type Transport,
  UdpTransport,
} from "../src";
import { createUdpTransport as createUdpTransportDirect } from "../src/transport";

describe("public api", () => {
  const activeTimerHandles = () =>
    ((process as any)._getActiveHandles?.() ?? []).filter((handle: any) => {
      const name = handle?.constructor?.name;
      return name === "Timeout" || name === "Immediate";
    }).length;

  test("exports createUdpTransport from index", () => {
    expect(createUdpTransport).toBe(createUdpTransportDirect);
    expect(UdpTransport).toBeDefined();
  });

  test("stop does not close transport by default and is idempotent", async () => {
    const transport: Transport = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport);

    await sctp.stop();
    await sctp.stop();

    expect(transport.close).not.toHaveBeenCalled();
  });

  test("stop clears pending handles and blocks timer re-scheduling", async () => {
    vi.useFakeTimers();
    const transport: Transport = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport);
    sctp.setRemotePort(5000);
    sctp.setState(SCTP_STATE.ESTABLISHED);

    for (let i = 0; i < 100; i++) {
      void sctp.send(0, WEBRTC_PPID.STRING, Buffer.from("ping"));
    }
    await Promise.resolve();

    await sctp.stop();
    transport.close();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const before = setTimeoutSpy.mock.calls.length;
    (sctp as any).timer1Expired();
    (sctp as any).timer2Expired();
    (sctp as any).timer3Expired();
    await (sctp as any).timerReconfigHandleExpired();
    expect(setTimeoutSpy.mock.calls.length).toBe(before);

    expect((sctp as any).timer1Handle).toBeUndefined();
    expect((sctp as any).timer2Handle).toBeUndefined();
    expect((sctp as any).timer3Handle).toBeUndefined();
    expect((sctp as any).timerReconfigHandle).toBeUndefined();
    expect((sctp as any).sackTimeout).toBeUndefined();
    expect(sctp.transport.onData).toBeUndefined();
    expect(transport.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("real timer teardown after burst send does not leave active timer handles", async () => {
    const transport: Transport = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sctp = SCTP.client(transport);
    sctp.setRemotePort(5000);
    sctp.setState(SCTP_STATE.ESTABLISHED);

    const baselineHandles = activeTimerHandles();
    for (let i = 0; i < 200; i++) {
      void sctp.send(0, WEBRTC_PPID.STRING, Buffer.from("ping")).catch(() => {});
    }

    await delay(20);
    await sctp.stop();
    sctp.transport.close();
    await delay(20);

    expect(sctp.transport.onData).toBeUndefined();
    expect(activeTimerHandles()).toBeLessThanOrEqual(baselineHandles);
  });
});
