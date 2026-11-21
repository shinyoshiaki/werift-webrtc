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
 * P2: after HVR2, the Flight3 loop for HVR1 must not retransmit.
 * Generation cancel: sleep wake with mismatched hvrGeneration exits without send.
 */
test("unit/flight3: superseded HVR generation stops stale CH2 retransmit", async () => {
  // Arrange: 送信を cookie / generation ごとに記録し、再送 sleep を手動で起こせる Flight3 を 2 つ用意する
  const transport = await UdpTransport.init("udp4");
  transport.rinfo = { address: "127.0.0.1", port: 9 } as any;

  const sendMeta: Array<{ gen: number; cookie: Buffer }> = [];
  transport.send = async () => {
    sendMeta.push({
      gen: dtls.hvrGeneration,
      cookie: Buffer.from(hello.cookie),
    });
  };

  const dtls = new DtlsContext({ transport } as any, SessionType.CLIENT);
  const cookieA = Buffer.alloc(20, 0xaa);
  const cookieB = Buffer.alloc(20, 0xbb);
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

  // Controllable sleep: resolve when released
  const sleepWaiters: Array<() => void> = [];
  dtls.flightSleep = () =>
    new Promise<void>((resolve) => {
      sleepWaiters.push(resolve);
    });

  const udp = new TransportContext(transport);
  const f3a = new Flight3(udp, dtls);
  const f3b = new Flight3(udp, dtls);

  const hvr1 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    cookieA,
  );
  const hvr2 = new ServerHelloVerifyRequest(
    { major: 254, minor: 253 },
    cookieB,
  );

  // Act: HVR1 を処理させ、CH2(cookieA) を送って再送 sleep に入らせる
  const p1 = f3a.exec(hvr1);
  await new Promise((r) => setTimeout(r, 20));
  expect(dtls.hvrGeneration).toBe(1);
  expect(sendMeta.length).toBe(1);
  expect(sendMeta[0].cookie.equals(cookieA)).toBe(true);
  expect(sleepWaiters.length).toBe(1);

  // Act: gen1 が sleep 中に HVR2 で置き換える
  dtls.flight = 3;
  const p2 = f3b.exec(hvr2);
  await new Promise((r) => setTimeout(r, 20));
  expect(dtls.hvrGeneration).toBe(2);
  expect(sendMeta.length).toBe(2);
  expect(sendMeta[1].cookie.equals(cookieB)).toBe(true);
  expect(sleepWaiters.length).toBe(2);

  // Act: gen1 の sleep を起こす。generation が違うので送信しないはず
  sleepWaiters[0]();
  await new Promise((r) => setTimeout(r, 20));
  expect(sendMeta.length).toBe(2); // no third send from stale loop

  // Act: gen2 を終わらせる
  dtls.flight = 5;
  sleepWaiters[1]?.();
  await Promise.all([p1, p2]);

  // Assert: generation ごとに 1 回だけ送信し、古いループは再送していない
  expect(sendMeta.length).toBe(2);
  expect(dtls.hvrGeneration).toBe(2);

  await transport.close().catch(() => {});
});
