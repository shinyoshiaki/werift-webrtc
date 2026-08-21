import {
  selectSignatureScheme,
  signCertificateVerify,
} from "../../../../cipher/tls13/signature";
import { HandshakeType } from "../../../../handshake/const";
import { Finished } from "../../../../handshake/message/finished";
import { Certificate13 } from "../../../../handshake/message/tls13/certificate";
import { CertificateVerify13 } from "../../../../handshake/message/tls13/certificateVerify";
import type { FragmentedHandshake } from "../../../../record/message/fragment";
import { createEpochProtection } from "../../../../record/v1_3/record";
import { log } from "../../types";
import { Dtls13ClientFlight4 } from "./flight4";

/**
 * Flight 5 (client): verify server Finished, then send {Certificate* CertificateVerify* Finished}.
 */
export abstract class Dtls13ClientFlight5 extends Dtls13ClientFlight4 {
  protected async onServerFinished(
    body: Buffer,
    _epoch: number,
  ): Promise<void> {
    const fin = Finished.deSerialize(body);
    const expected = this.keySchedule.verifyData(
      this.serverHsTraffic!,
      this.transcript.bytes,
    );
    if (!fin.verifyData.equals(expected)) {
      throw new Error("server Finished verify_data mismatch");
    }
    this.transcript.add(HandshakeType.finished_20, body);
    this.peerFinishedReceived = true;

    const appSecrets = this.keySchedule.deriveApplicationSecrets(
      this.handshakeSecret!,
      this.transcript.bytes,
    );
    this.clientAppTraffic = appSecrets.clientApplicationTrafficSecret;
    this.serverAppTraffic = appSecrets.serverApplicationTrafficSecret;
    this.exporterMasterSecret = appSecrets.exporterMasterSecret;

    const ep3 = createEpochProtection(3);
    ep3.writeKeys = this.keySchedule.trafficKeys(this.clientAppTraffic);
    ep3.readKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
    this.installEpoch(3, ep3);

    // Optional client Certificate + CertificateVerify for mutual auth
    // RFC 8446: if no suitable cert / scheme, send empty Certificate and skip CV.
    const clientMsgs: FragmentedHandshake[] = [];
    if (this.peerRequestedClientCert) {
      if (
        this.presentClientCertificate &&
        this.hasLocalIdentity &&
        this.certDer.length &&
        this.keyPem
      ) {
        const cCert = new Certificate13(this.certificateRequestContext, [
          this.certDer,
        ]);
        this.messageSeq += 1;
        cCert.messageSeq = this.messageSeq;
        this.transcript.add(HandshakeType.certificate_11, cCert.serialize());
        const cFrag = cCert.toFragment();
        cFrag.message_seq = cCert.messageSeq;
        clientMsgs.push(cFrag);

        const clientCvScheme = selectSignatureScheme(
          this.keyPem,
          this.certificateRequestSignatureSchemes.length
            ? this.certificateRequestSignatureSchemes
            : this.peerSignatureSchemes,
        );
        const { algorithm, signature } = signCertificateVerify(
          this.keyPem,
          false,
          this.transcript.bytes,
          clientCvScheme,
        );
        const cCv = new CertificateVerify13(algorithm, signature);
        this.messageSeq += 1;
        cCv.messageSeq = this.messageSeq;
        this.transcript.add(
          HandshakeType.certificate_verify_15,
          cCv.serialize(),
        );
        const cvFrag = cCv.toFragment();
        cvFrag.message_seq = cCv.messageSeq;
        clientMsgs.push(cvFrag);
      } else {
        // Empty Certificate decline (no CertificateVerify)
        const emptyCert = new Certificate13(this.certificateRequestContext, []);
        this.messageSeq += 1;
        emptyCert.messageSeq = this.messageSeq;
        this.transcript.add(
          HandshakeType.certificate_11,
          emptyCert.serialize(),
        );
        const eFrag = emptyCert.toFragment();
        eFrag.message_seq = emptyCert.messageSeq;
        clientMsgs.push(eFrag);
      }
    }

    // Send client Finished
    const clientVd = this.keySchedule.verifyData(
      this.clientHsTraffic!,
      this.transcript.bytes,
    );
    const clientFin = new Finished(clientVd);
    this.messageSeq += 1;
    clientFin.messageSeq = this.messageSeq;
    const cfBody = clientFin.serialize();
    this.transcript.add(HandshakeType.finished_20, cfBody);

    const frag = clientFin.toFragment();
    frag.message_seq = clientFin.messageSeq;
    clientMsgs.push(frag);
    // Final flight is retransmittable until server ACK (RFC 9147)
    await this.sendHandshakeFlight(clientMsgs, 2, true);

    // RX layer will sendAck() after noting this Finished record number
    this.ackAfterCurrentRecord = true;

    this.writeEpoch = 3;
    this.readEpoch = 3;
    this.localFinishedSent = true;
    // Keep pending final-flight retransmit until ACK clears it
    this.markConnected({ keepPendingFlight: true });
    log("client connected");
  }
}
