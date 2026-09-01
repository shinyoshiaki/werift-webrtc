import { HandshakeType } from "../../../../handshake/const";
import { Finished } from "../../../../handshake/message/finished";
import { AlertDesc } from "../../../../record/const";
import { DtlsProtocolError } from "../../../../version";
import type { Dtls13Host } from "../../host";
import { log } from "../../types";

/**
 * Flight 5 receive (server): client {Certificate* CertificateVerify* Finished}.
 */
export async function onClientFinished(
  this: Dtls13Host,
  body: Buffer,
  epoch: number,
): Promise<void> {
  // RFC 9147: handshake traffic keys are epoch 2 (epoch 1 reserved, app is 3+)
  if (epoch !== 2) {
    throw new DtlsProtocolError(
      `unexpected_message: client Finished on epoch ${epoch} (expected 2)`,
      AlertDesc.UnexpectedMessage,
    );
  }
  const fin = Finished.deSerialize(body);
  if (this.expectClientCertificate) {
    if (!this.clientCertificateReceived) {
      throw new Error("client Finished before Certificate (mutual auth)");
    }
    if (!this.clientCertificateVerified) {
      // Empty Certificate decline or failed CV → certificate_required
      await this.sendFatalAlert(AlertDesc.CertificateRequired);
      this.fail(
        new Error(
          "certificate_required: client did not present a valid certificate",
        ),
      );
      return;
    }
  }
  const expected = this.keySchedule.verifyData(
    this.clientHsTraffic!,
    this.transcript.bytes,
  );
  if (!fin.verifyData.equals(expected)) {
    throw new Error("client Finished verify_data mismatch");
  }
  this.transcript.add(HandshakeType.finished_20, body);
  this.peerFinishedReceived = true;

  // Ensure app read keys present (also installed after server Finished)
  const ep3 = this.epochs.get(3)!;
  if (!ep3.readKeys) {
    ep3.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic!);
  }
  this.readEpoch = 3;
  this.writeEpoch = 3;

  // RX layer will sendAck() after noting this Finished record number
  this.ackAfterCurrentRecord = true;

  this.markConnected();
  log("server connected");
}
