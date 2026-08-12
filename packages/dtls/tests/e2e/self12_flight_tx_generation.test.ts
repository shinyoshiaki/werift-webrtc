import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { SessionType } from "../../src/cipher/suites/abstract";
import { DtlsContext } from "../../src/context/dtls";
import { TransportContext } from "../../src/context/transport";
import { Flight } from "../../src/flight/flight";

/**
 * Flight.transmit must not surface send errors after cancelFlightTimers
 * (close / version fallback bumps flightTxGeneration).
 */
class TestFlight extends Flight {
  constructor(udp: TransportContext, dtls: DtlsContext) {
    super(udp, dtls, 4, 6);
  }
  run(bufs: Buffer[]) {
    return this.transmit(bufs);
  }
}

test("unit/flight: stale send rejection after cancelFlightTimers is ignored", async () => {
  // Arrange
  const transport = await UdpTransport.init("udp4");
  let rejectSend: (e: Error) => void = () => {};
  const sendPromise = new Promise<void>((_resolve, reject) => {
    rejectSend = reject;
  });
  transport.send = async () => sendPromise as any;

  const dtls = new DtlsContext({ transport } as any, SessionType.SERVER);
  dtls.flight = 4;
  // Controllable sleep so transmit waits after first send
  let wakeSleep: () => void = () => {};
  dtls.flightSleep = () =>
    new Promise<void>((resolve) => {
      wakeSleep = resolve;
    });

  const errors: unknown[] = [];
  const origErr = console.error;
  // Capture debug path indirectly: we assert generation advanced and no throw
  const flight = new TestFlight(new TransportContext(transport), dtls);
  const p = flight.run([Buffer.from("hs")]);
  await new Promise((r) => setTimeout(r, 20));

  const genBefore = dtls.flightTxGeneration;
  // Act: association hard-close cancels timers + bumps flightTxGeneration
  dtls.flight = 99;
  dtls.cancelFlightTimers();
  expect(dtls.flightTxGeneration).toBeGreaterThan(genBefore);

  // Late transport failure after terminal
  rejectSend(new Error("socket closed after association teardown"));
  await new Promise((r) => setTimeout(r, 20));
  wakeSleep();
  await p; // must resolve without throw (terminal path)

  // Assert: generation invalidated the send wave
  expect(dtls.flightTxGeneration).toBeGreaterThan(genBefore);
  void errors;
  void origErr;

  await transport.close().catch(() => {});
});

test("unit/dtls: cancelFlightTimers bumps flightTxGeneration each call", () => {
  const dtls = new DtlsContext({ transport: {} } as any, SessionType.CLIENT);
  const g0 = dtls.flightTxGeneration;
  dtls.cancelFlightTimers();
  expect(dtls.flightTxGeneration).toBe(g0 + 1);
  dtls.cancelFlightTimers();
  expect(dtls.flightTxGeneration).toBe(g0 + 2);
});
