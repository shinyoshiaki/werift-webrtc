import { expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { SessionType } from "../../src/cipher/suites/abstract";
import { DtlsContext } from "../../src/context/dtls";
import { TransportContext } from "../../src/context/transport";
import { Flight3 } from "../../src/flight/client/flight3";
import { ClientHello } from "../../src/handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../src/handshake/message/server/helloVerifyRequest";
import { DtlsRandom } from "../../src/handshake/random";

/**
 * Ticket C required scenario (deterministic, no wall-clock flake):
 *
 *   HVR1 → CH2(cookie1) → HVR2 → drop CH2(cookie2) TX observation →
 *   wake stale gen1 RTO → cookie1 must NOT retransmit;
 *   only cookie2 generation remains active.
 *
 * Pre-fix: Flight3 retransmit loops ignored hvrGeneration, so gen1 would
 * re-send cookie1 after HVR2 superseded it.
 */
test("e2e/flight3: HVR2 supersedes; stale gen1 RTO does not retransmit cookie1", async () => {
  // Arrange: 送信ごとに cookie / generation を記録し、再送 sleep を手動で起こせる Flight3 を 2 つ用意する
  const transport = await UdpTransport.init("udp4");
  transport.rinfo = { address: "127.0.0.1", port: 9 } as any;

  const sends: Array<{ cookie: Buffer; gen: number }> = [];
  transport.send = async () => {
    // Observe cookie currently embedded in lastFlight ClientHello
    const hello = dtls.lastFlight[0] as ClientHello;
    sends.push({
      cookie: Buffer.from(hello.cookie),
      gen: dtls.hvrGeneration,
    });
  };

  const dtls = new DtlsContext({ transport } as any, SessionType.CLIENT);
  const hello = new ClientHello(
    { major: 254, minor: 253 },
    new DtlsRandom(),
    Buffer.alloc(0),
    Buffer.alloc(0),
    [0xc02f],
    [0],
    [],
  );
  dtls.lastFlight = [hello] as any;
  dtls.flight = 1;

  const sleepWaiters: Array<() => void> = [];
  dtls.flightSleep = () =>
    new Promise<void>((resolve) => {
      sleepWaiters.push(resolve);
    });

  const udp = new TransportContext(transport);
  const f3a = new Flight3(udp, dtls);
  const f3b = new Flight3(udp, dtls);

  /** Count Flight3 instances still in WAITING (active retransmit owner). */
  const activeFlight3Waiting = () =>
    [f3a, f3b].filter((f) => f.state === "WAITING").length;

  const cookie1 = Buffer.alloc(20, 0x11);
  const cookie2 = Buffer.alloc(20, 0x22);
  const hvr1 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    cookie1,
  );
  const hvr2 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    cookie2,
  );

  // Act: HVR1 を処理させ、CH2(cookie1) を送って RTO 待ちの sleep に入らせる
  const p1 = f3a.exec(hvr1);
  await new Promise((r) => setTimeout(r, 15));
  expect(sends.length).toBe(1);
  expect(sends[0].cookie.equals(cookie1)).toBe(true);
  expect(dtls.hvrGeneration).toBe(1);
  expect(sleepWaiters.length).toBe(1);
  // Exactly one Flight3 retransmit loop is waiting
  expect(activeFlight3Waiting()).toBe(1);
  expect(f3a.state).toBe("WAITING");

  // Act: gen1 が sleep 中に HVR2 を処理させ、有効な cookie を cookie2 にする
  dtls.flight = 3;
  const p2 = f3b.exec(hvr2);
  await new Promise((r) => setTimeout(r, 15));
  expect(dtls.hvrGeneration).toBe(2);
  expect(sends.length).toBe(2);
  expect(sends[1].cookie.equals(cookie2)).toBe(true);
  // Both instances may be WAITING until gen1 wakes and observes mismatch
  expect(f3a.state).toBe("WAITING");
  expect(f3b.state).toBe("WAITING");
  expect(activeFlight3Waiting()).toBe(2);

  // Act: gen2 はまだ起こさず（CH2(cookie2) の再送が落ちた想定）、古い gen1 の RTO を発火させる
  // Assert: gen1 は cookie1 を再送せず FINISHED で抜け、再送ループは gen2 だけになる
  sleepWaiters[0]();
  await new Promise((r) => setTimeout(r, 15));
  expect(sends.length).toBe(2); // no third send from stale gen1
  expect(f3a.state).toBe("FINISHED"); // superseded generation exits
  // Direct assertion: only one Flight3 loop remains active (WAITING)
  expect(activeFlight3Waiting()).toBe(1);
  expect(f3b.state).toBe("WAITING");

  // Act: 残った gen2 を 1 回起こす
  // Assert: gen2 の再送は cookie2 だけで、cookie1 は二度と現れない
  dtls.flight = 3; // still waiting for SH
  sleepWaiters[1]?.();
  await new Promise((r) => setTimeout(r, 15));
  // gen2 retransmit of cookie2 is allowed; cookie1 never appears again
  const afterStale = sends.slice(2);
  for (const s of afterStale) {
    expect(s.cookie.equals(cookie2)).toBe(true);
    expect(s.cookie.equals(cookie1)).toBe(false);
  }
  // Still only gen2 owns retransmit (may be WAITING again after re-send)
  expect(f3a.state).toBe("FINISHED");
  expect(activeFlight3Waiting()).toBeLessThanOrEqual(1);

  // Act: ループをすべて終わらせる
  dtls.flight = 5;
  for (const w of sleepWaiters) w();
  await Promise.all([p1, p2]);
  expect(f3b.state).toBe("FINISHED");
  expect(activeFlight3Waiting()).toBe(0);

  // Assert: 最初の送信だけが cookie1 で、それ以降の送信はすべて cookie2
  expect(sends[0].cookie.equals(cookie1)).toBe(true);
  expect(sends.slice(1).every((s) => s.cookie.equals(cookie2))).toBe(true);
  // At most one pending Flight3 loop for the active generation
  expect(dtls.hvrGeneration).toBe(2);

  await transport.close().catch(() => {});
});
