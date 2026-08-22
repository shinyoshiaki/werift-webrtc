import { CurveType, certificateTypes, signatures } from "../../cipher/const";
import type { CipherContext } from "../../context/cipher";
import type { DtlsContext } from "../../context/dtls";
import type { SrtpContext } from "../../context/srtp";
import type { TransportContext } from "../../context/transport";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { Certificate } from "../../handshake/message/certificate";
import { ServerCertificateRequest } from "../../handshake/message/server/certificateRequest";
import { ServerHello } from "../../handshake/message/server/hello";
import { ServerHelloDone } from "../../handshake/message/server/helloDone";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange";
import { debug } from "../../imports/common";
import type { FragmentedHandshake } from "../../record/message/fragment";
import type { Extension } from "../../typings/domain";
import {
  DtlsVersion,
  normalizeProtocolVersions,
  supportsVersion,
} from "../../version";
import { Flight } from "../flight";

const log = debug("werift-dtls : packages/dtls/flight/server/flight4.ts : log");

export class Flight4 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
    private srtp: SrtpContext,
  ) {
    super(udp, dtls, 4, 6);
  }

  async exec(
    clientHello: FragmentedHandshake,
    certificateRequest: boolean = false,
  ) {
    if (this.dtls.flight === 4) {
      log(this.dtls.sessionId, "flight4 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 4;
    // ServerHello message_seq corresponds to the final cookie-validated
    // ClientHello (CH1=0 → HVR=0; CH2=1 → SH=1; re-challenge CH3=2 → SH=2).
    this.dtls.sequenceNumber = clientHello.message_seq;
    this.dtls.bufferHandshakeCache([clientHello], false, 4);

    const messages = [
      this.sendServerHello(),
      this.sendCertificate(),
      this.sendServerKeyExchange(),
      certificateRequest && this.sendCertificateRequest(),
      this.sendServerHelloDone(),
    ].filter((v) => v) as Buffer[];

    this.dtls.lastMessage = messages;
    await this.transmit(messages);
  }

  private sendServerHello() {
    // todo fix; should use socket.extensions
    const extensions: Extension[] = [];
    if (this.srtp.srtpProfile) {
      // mki is payload-only (RFC 5764); empty Buffer → wire mki_len=0.
      // Do not pass Buffer.from([0x00]) — that is a 1-byte MKI, not "empty".
      extensions.push(
        UseSRTP.create([this.srtp.srtpProfile], Buffer.alloc(0)).extension,
      );
    }
    if (this.dtls.options.extendedMasterSecret) {
      extensions.push({
        type: ExtendedMasterSecret.type,
        data: Buffer.alloc(0),
      });
    }
    const renegotiationIndication = RenegotiationIndication.createEmpty();
    extensions.push(renegotiationIndication.extension);

    // RFC 8446 §4.1.3 / RFC 9147: a TLS 1.3-capable server that negotiates
    // TLS 1.2 (this flight) MUST place DOWNGRD\x01 in ServerHello.Random[24..31].
    // Dual [V1_3, V1_2] servers always set this when on the 1.2 flight path.
    const versions = normalizeProtocolVersions(
      this.dtls.options.protocolVersions,
    );
    if (supportsVersion(versions, DtlsVersion.V1_3)) {
      this.cipher.localRandom.applyTls12DowngradeSentinel();
    }

    const serverHello = new ServerHello(
      this.dtls.version,
      this.cipher.localRandom,
      Buffer.from([0x00]),
      this.cipher.cipherSuite,
      0, // do not compression
      extensions,
    );
    const packets = this.createPacket([serverHello]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  // 7.4.2 Server Certificate
  private sendCertificate() {
    const certificate = new Certificate([Buffer.from(this.cipher.localCert)]);

    const packets = this.createPacket([certificate]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  private sendServerKeyExchange() {
    const signature = this.cipher.generateKeySignature("sha256");
    if (!this.cipher.signatureHashAlgorithm) throw new Error("not exist");

    const keyExchange = new ServerKeyExchange(
      CurveType.named_curve_3,
      this.cipher.namedCurve,
      this.cipher.localKeyPair.publicKey.length,
      this.cipher.localKeyPair.publicKey,
      this.cipher.signatureHashAlgorithm.hash,
      this.cipher.signatureHashAlgorithm.signature,
      signature.length,
      signature,
    );

    const packets = this.createPacket([keyExchange]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  // 7.4.4.  Certificate Request
  private sendCertificateRequest() {
    const handshake = new ServerCertificateRequest(
      certificateTypes,
      signatures,
      [],
    );
    log(this.dtls.sessionId, "sendCertificateRequest", handshake);
    const packets = this.createPacket([handshake]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  private sendServerHelloDone() {
    const handshake = new ServerHelloDone();

    const packets = this.createPacket([handshake]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }
}
