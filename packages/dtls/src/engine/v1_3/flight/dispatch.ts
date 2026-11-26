import { HandshakeType } from "../../../handshake/const";
import { ServerHelloVerifyRequest } from "../../../handshake/message/server/helloVerifyRequest";
import { AlertDesc } from "../../../record/const";
import type { FragmentedHandshake } from "../../../record/message/fragment";
import {
  DtlsProtocolError,
  DtlsVersion,
  DtlsVersionSelected,
  ProtocolVersionError,
  supportsVersion,
} from "../../../version";
import type { Dtls13Host } from "../host";
import { log } from "../types";

/**
 * Handshake message handlers ordered like index.ts Figure 3 flights:
 *   Flight 1/3 ClientHello → Flight 2 HRR* → Flight 4 server → Flight 5 client → post-HS KeyUpdate / NewSessionTicket
 */
/**
 * RFC 8446 full-handshake order. Returns false if the type is not expected
 * in the current hsPhase (caller must abort with unexpected_message).
 */
export function isExpectedHandshakeType(
  this: Dtls13Host,
  msgType: number,
): boolean {
  if (msgType === HandshakeType.key_update_24) {
    return this.hsPhase === "connected";
  }
  if (msgType === HandshakeType.new_session_ticket_4) {
    return this.role === "client" && this.hsPhase === "connected";
  }
  if (this.role === "client") {
    switch (this.hsPhase) {
      case "wait_server_hello":
        return (
          msgType === HandshakeType.server_hello_2 ||
          msgType === HandshakeType.hello_verify_request_3
        );
      case "wait_ee":
        return msgType === HandshakeType.encrypted_extensions_8;
      case "wait_cert_or_cr":
        return (
          msgType === HandshakeType.certificate_request_13 ||
          msgType === HandshakeType.certificate_11
        );
      case "wait_cert":
        return msgType === HandshakeType.certificate_11;
      case "wait_cv":
        return msgType === HandshakeType.certificate_verify_15;
      case "wait_finished":
        return msgType === HandshakeType.finished_20;
      case "connected":
        return false; // KeyUpdate / NewSessionTicket handled above
      default:
        return false;
    }
  }
  // server
  switch (this.hsPhase) {
    case "wait_client_hello":
      return msgType === HandshakeType.client_hello_1;
    case "wait_client_cert":
      return msgType === HandshakeType.certificate_11;
    case "wait_client_cv":
      return msgType === HandshakeType.certificate_verify_15;
    case "wait_client_finished":
      return msgType === HandshakeType.finished_20;
    case "connected":
      return false;
    default:
      return false;
  }
}

export async function dispatchHandshake(
  this: Dtls13Host,

  hs: FragmentedHandshake,
  epoch: number,
): Promise<void> {
  const body = hs.fragment;
  log(
    this.role,
    "recv handshake",
    hs.msg_type,
    "seq",
    hs.message_seq,
    "epoch",
    epoch,
    "phase",
    this.hsPhase,
  );

  if (!this.isExpectedHandshakeType(hs.msg_type)) {
    throw new DtlsProtocolError(
      `unexpected_message: handshake type ${hs.msg_type} in phase ${this.hsPhase}`,
      AlertDesc.UnexpectedMessage,
    );
  }

  switch (hs.msg_type) {
    case HandshakeType.client_hello_1:
      if (this.role === "server") {
        await this.onClientHello(body, hs.message_seq);
      }
      break;
    case HandshakeType.hello_verify_request_3:
      if (this.role === "client") {
        // DTLS 1.2 cookie challenge (unauthenticated). Dual association may
        // continue on the 1.2 cookie path while still advertising 1.3 in
        // supported_versions — never treat HVR as "drop to pure 1.2-only".
        if (supportsVersion(this.offeredProtocolVersions, DtlsVersion.V1_2)) {
          const hvr = ServerHelloVerifyRequest.deSerialize(body);
          throw new DtlsVersionSelected(
            DtlsVersion.V1_2,
            "peer HelloVerifyRequest: continue dual negotiation on DTLS 1.2 cookie path",
            Buffer.from(hvr.cookie),
          );
        }
        throw new ProtocolVersionError(
          "received HelloVerifyRequest: peer is DTLS 1.2-only but client is DTLS 1.3-only",
        );
      }
      break;
    case HandshakeType.server_hello_2:
      if (this.role === "client") {
        await this.onServerHello(body, hs.message_seq);
      }
      break;
    case HandshakeType.encrypted_extensions_8:
      if (this.role === "client") {
        await this.onEncryptedExtensions(body);
        this.hsPhase = "wait_cert_or_cr";
      }
      break;
    case HandshakeType.certificate_request_13:
      if (this.role === "client") {
        await this.onCertificateRequest(body);
        this.hsPhase = "wait_cert";
      }
      break;
    case HandshakeType.certificate_11:
      await this.onCertificate(body);
      if (this.role === "client") {
        this.hsPhase = "wait_cv";
      } else {
        // server: non-empty client Certificate → CV; empty decline → Finished
        this.hsPhase = this.remoteCert
          ? "wait_client_cv"
          : "wait_client_finished";
      }
      break;
    case HandshakeType.certificate_verify_15:
      await this.onCertificateVerify(body);
      if (this.role === "client") {
        this.hsPhase = "wait_finished";
      } else {
        this.hsPhase = "wait_client_finished";
      }
      break;
    case HandshakeType.finished_20:
      await this.onFinished(body, epoch);
      break;
    case HandshakeType.key_update_24:
      this.onKeyUpdate(body);
      break;
    case HandshakeType.new_session_ticket_4:
      this.onNewSessionTicket(body);
      break;
    default:
      log("ignored handshake type", hs.msg_type);
  }
}
