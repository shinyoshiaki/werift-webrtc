import { verifyCertificateVerify } from "../../../cipher/tls13/signature";
import { HandshakeType } from "../../../handshake/const";
import { Certificate13 } from "../../../handshake/message/tls13/certificate";
import { CertificateVerify13 } from "../../../handshake/message/tls13/certificateVerify";
import { Dtls13FlightDispatch } from "./dispatch";

/** Shared Certificate / CertificateVerify receive path (both roles). */
export abstract class Dtls13HandshakeCertificate extends Dtls13FlightDispatch {
  protected async onCertificate(body: Buffer): Promise<void> {
    const cert = Certificate13.deSerialize(body);
    // Empty certificate list = client decline (RFC 8446 §4.4.2). Server policy
    // may still reject after Finished if a certificate was required.
    if (this.role === "server" && this.expectClientCertificate) {
      // RFC 8446: client Certificate.context MUST equal CertificateRequest.context
      if (
        !cert.certificateRequestContext.equals(this.certificateRequestContext)
      ) {
        throw new Error("client certificate_request_context mismatch");
      }
      this.clientCertificateReceived = true;
      if (!cert.certificates.length) {
        // Decline: no CertificateVerify expected; leave verified=false
        this.transcript.add(HandshakeType.certificate_11, body);
        return;
      }
      this.remoteCert = cert.certificates[0];
      // Verified becomes true only after successful CertificateVerify
      this.transcript.add(HandshakeType.certificate_11, body);
      return;
    }
    if (!cert.certificates.length) {
      throw new Error("empty certificate list");
    }
    // Server Certificate context MUST be zero-length in main handshake
    if (cert.certificateRequestContext.length !== 0) {
      throw new Error(
        "illegal_parameter: server Certificate.certificate_request_context must be empty",
      );
    }
    this.remoteCert = cert.certificates[0];
    this.transcript.add(HandshakeType.certificate_11, body);
  }

  protected async onCertificateVerify(body: Buffer): Promise<void> {
    if (!this.remoteCert)
      throw new Error("CertificateVerify without Certificate");
    const cv = CertificateVerify13.deSerialize(body);
    // Client only verifies server CertificateVerify; server verifies client CV for mutual auth
    const peerIsServer = this.role === "client";
    // Accept only schemes we actually advertised for this handshake direction
    const allowed =
      this.role === "client"
        ? this.localOfferedSignatureSchemes
        : this.certificateRequestSignatureSchemes;
    if (!allowed.includes(cv.algorithm)) {
      throw new Error(
        `CertificateVerify algorithm 0x${cv.algorithm.toString(16)} not negotiated`,
      );
    }
    const ok = verifyCertificateVerify(
      this.remoteCert,
      cv.algorithm,
      cv.signature,
      peerIsServer,
      this.transcript.bytes,
    );
    if (!ok) {
      throw new Error("CertificateVerify signature verification failed");
    }
    this.transcript.add(HandshakeType.certificate_verify_15, body);
    if (this.role === "server" && this.expectClientCertificate) {
      this.clientCertificateVerified = true;
    }
  }
}
