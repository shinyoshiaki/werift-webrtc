import { describe, expect, test, vi } from "vitest";

import { SCTP, createUdpTransport, type Transport, UdpTransport } from "../src";
import { createUdpTransport as createUdpTransportDirect } from "../src/transport";

describe("public api", () => {
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
});
