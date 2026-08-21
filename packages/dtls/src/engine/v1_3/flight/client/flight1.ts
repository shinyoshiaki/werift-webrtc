import {
  CipherSuite,
  type NamedCurveAlgorithms,
} from "../../../../cipher/const";
import { generateKeyPair } from "../../../../cipher/namedCurve";
import { HandshakeType } from "../../../../handshake/const";
import { CookieExtension } from "../../../../handshake/extensions/cookie";
import { EllipticCurves } from "../../../../handshake/extensions/ellipticCurves";
import { KeyShare } from "../../../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../../../handshake/extensions/useSrtp";
import { ClientHello } from "../../../../handshake/message/client/hello";
import type { Extension } from "../../../../typings/domain";
import {
  DTLS_1_3_VERSION,
  DtlsVersion,
  WireVersion,
  protocolVersionsToWire,
  supportsVersion,
} from "../../../../version";
import type { Dtls13Host } from "../../host";

/**
 * Flight 1 / 3: ClientHello (index.ts Figure 3).
 * After HRR, {@link sendClientHello} is reused with a new key_share group.
 */
export async function sendClientHello(
  this: Dtls13Host,
  hrrGroup?: number,
): Promise<void> {
  if (hrrGroup) {
    this.selectedGroup = hrrGroup as NamedCurveAlgorithms;
    this.localKeyPair = generateKeyPair(this.selectedGroup);
  }

  const extensions = this.buildClientHelloExtensions();
  // Dual CH advertises 1.2 cipher suites too so a 1.2-only peer can complete
  // cookie + 1.2 selection without rejecting "only 0x1301" ClientHellos.
  const cipherSuites: number[] = [CipherSuite.TLS_AES_128_GCM_SHA256_0x1301];
  if (supportsVersion(this.offeredProtocolVersions, DtlsVersion.V1_2)) {
    cipherSuites.push(
      CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195,
      CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
    );
  }
  const ch = new ClientHello(
    WireVersion.DTLS_1_2, // legacy_version
    this.clientRandom,
    this.sessionId,
    Buffer.alloc(0), // legacy_cookie must be empty in DTLS 1.3
    cipherSuites,
    [0],
    extensions,
  );
  // message_seq: first CH = 0; after HRR second CH increments (new message)
  if (this.awaitingHrr) {
    this.messageSeq = 1;
  } else if (!this.firstClientHelloBody) {
    this.messageSeq = 0;
  }
  // else retransmit: keep messageSeq
  ch.messageSeq = this.messageSeq;

  const body = ch.serialize();
  // Track offered extension types for EncryptedExtensions allowlist (client)
  this.clientOfferedExtensionTypes = new Set(ch.extensions.map((e) => e.type));
  if (!this.firstClientHelloBody) {
    this.firstClientHelloBody = body;
    // Snapshot key_share groups from the first CH for HRR validation
    this.initialKeyShareGroups = [this.selectedGroup];
    this.transcript.add(HandshakeType.client_hello_1, body);
  } else if (this.awaitingHrr) {
    // After HRR, second CH is added after message_hash already set
    this.transcript.add(HandshakeType.client_hello_1, body);
    this.awaitingHrr = false;
  } else {
    // Retransmit: do not re-add to transcript
  }

  const frag = ch.toFragment();
  frag.message_seq = this.messageSeq;
  await this.sendHandshakeFlight([frag], 0, true);
  this.clientExpectsServerFlight = true;
}

export function buildClientHelloExtensions(this: Dtls13Host): Extension[] {
  const exts: Extension[] = [];

  // Dual-stack association may advertise both 1.3 and 1.2 in preference order
  const wireVersions = protocolVersionsToWire(this.offeredProtocolVersions);
  // Always include 1.3 when this engine is used (offered list may be dual)
  if (!wireVersions.includes(DTLS_1_3_VERSION)) {
    wireVersions.unshift(DTLS_1_3_VERSION);
  }
  exts.push(SupportedVersions.forClient(wireVersions).clientExtension);

  const curves = EllipticCurves.createEmpty();
  curves.data = this.groups as any;
  exts.push(curves.extension);

  // Only send key share for selected group
  exts.push(
    KeyShare.forClient([
      {
        group: this.selectedGroup,
        keyExchange: this.localKeyPair.publicKey,
      },
    ]).clientExtension,
  );

  // Dual CH also lists rsa_pkcs1_sha256 so DTLS 1.2 peers (flight2) can match
  // RSA certificates; 1.3 CertificateVerify still rejects PKCS#1.
  const sigSchemes = [...this.localOfferedSignatureSchemes];
  if (
    supportsVersion(this.offeredProtocolVersions, DtlsVersion.V1_2) &&
    !sigSchemes.includes(0x0401)
  ) {
    sigSchemes.push(0x0401); // rsa_pkcs1_sha256 for 1.2 peers only
  }
  exts.push(SignatureAlgorithms.create(sigSchemes).extension);

  if (this.tlsCookie.length > 0) {
    exts.push(new CookieExtension(this.tlsCookie).extension);
  }

  if (this.options.srtpProfiles?.length) {
    // Empty MKI payload (RFC 5764 opaque srtp_mki<0..255> with length 0)
    this.clientOfferedSrtpMki = Buffer.alloc(0);
    exts.push(
      UseSRTP.create(this.options.srtpProfiles, this.clientOfferedSrtpMki)
        .extension,
    );
  }

  return exts;
}
