import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { DtlsAck } from "../../src/handshake/message/tls13/ack";
import { ContentType } from "../../src/record/const";
import { serializePlaintextRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

describe("e2e/self13 plaintext ACK after protected state", () => {
  test(
    "forged epoch-0 ACK does not advance KeyUpdate write epoch",
    async () => {
      // Arrange
      const serverTransport = await UdpTransport.init("udp4");
      const clientTransport = await UdpTransport.init("udp4");
      clientTransport.rinfo = serverTransport.address;
      const server = new DtlsServer({
        transport: serverTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      });
      const client = new DtlsClient({
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      });

      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("plaintext ACK attack timeout")),
          15_000,
        );
        client.onConnect.subscribe(async () => {
          try {
            const eng = (client as any).engine13;
            // Settle HS flight
            const settle = Date.now() + 2000;
            while (eng.getPendingFlightSize() > 0 && Date.now() < settle) {
              await new Promise((r) => setTimeout(r, 20));
            }
            const writeBefore = eng.writeEpoch as number;
            await client.keyUpdate(false);
            expect(eng.pendingKeyUpdateWrite).toBeTruthy();
            // Snapshot pending record numbers to forge against
            const pending: { epoch: number; sequenceNumber: number }[] =
              eng.pendingFlightRecords.map((r: any) => ({
                epoch: r.epoch,
                sequenceNumber: r.sequenceNumber,
              }));
            expect(pending.length).toBeGreaterThan(0);

            // Act: call handleAck as if a forged epoch-0 ACK arrived claiming
            // the encrypted KeyUpdate records (Erratum 8108 attack)
            eng.handleAck(new DtlsAck(pending).serialize(), 0);

            // Assert: write epoch must NOT advance (epoch 0 cannot ACK epoch≥2)
            expect(eng.writeEpoch).toBe(writeBefore);
            expect(eng.pendingKeyUpdateWrite).toBeTruthy();
            expect(eng.pendingFlightRecords.length).toBe(pending.length);

            // Real ACK on the correct epoch still works
            eng.handleAck(
              new DtlsAck(pending).serialize(),
              writeBefore, // received on same epoch as KeyUpdate
            );
            expect(eng.pendingKeyUpdateWrite).toBeUndefined();
            expect(eng.writeEpoch).toBeGreaterThan(writeBefore);

            clearTimeout(timer);
            client.close();
            server.close();
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
        client.onError.subscribe((e) => {
          clearTimeout(timer);
          reject(e);
        });
        server.onError.subscribe((e) => {
          clearTimeout(timer);
          reject(e);
        });
        await client.connect();
      });
    },
    20_000,
  );

  test(
    "forged epoch-0 empty ACK does not drive retransmit after connected",
    async () => {
      // Arrange
      const serverTransport = await UdpTransport.init("udp4");
      const clientTransport = await UdpTransport.init("udp4");
      clientTransport.rinfo = serverTransport.address;
      const server = new DtlsServer({
        transport: serverTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      });
      const client = new DtlsClient({
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        protocolVersions: [DtlsVersion.V1_3],
        addressValidation: "none",
      });

      await new Promise<void>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("empty ACK retransmit timeout")),
          15_000,
        );
        client.onConnect.subscribe(async () => {
          try {
            const eng = (client as any).engine13;
            const settle = Date.now() + 2000;
            while (eng.getPendingFlightSize() > 0 && Date.now() < settle) {
              await new Promise((r) => setTimeout(r, 20));
            }
            const writeBefore = eng.writeEpoch as number;
            await client.keyUpdate(false);
            const retransmitBefore = eng.retransmitCount as number;

            // Act: empty epoch-0 ACKs after protected state must not retransmit
            for (let i = 0; i < 5; i++) {
              eng.handleAck(new DtlsAck([]).serialize(), 0);
            }
            expect(eng.retransmitCount).toBe(retransmitBefore);

            // Matching ACK on the KeyUpdate send epoch clears pending
            const pending = eng.pendingFlightRecords.slice();
            eng.handleAck(new DtlsAck(pending).serialize(), writeBefore);
            expect(eng.pendingKeyUpdateWrite).toBeUndefined();

            clearTimeout(timer);
            client.close();
            server.close();
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
        client.onError.subscribe((e) => {
          clearTimeout(timer);
          reject(e);
        });
        server.onError.subscribe((e) => {
          clearTimeout(timer);
          reject(e);
        });
        await client.connect();
      });
    },
    20_000,
  );
});
