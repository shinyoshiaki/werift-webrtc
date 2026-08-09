import { createHandshakeDatagram } from "../../carrier/direct";
import {
  CipherSuite,
  NamedCurveAlgorithm,
  type NamedCurveAlgorithms,
} from "../../cipher/const";
import { generateKeyPair } from "../../cipher/namedCurve";
import { prfPreMasterSecret } from "../../cipher/prf";
import { hashSha256 } from "../../cipher/tls13/hkdf";
import {
  selectSignatureScheme,
  signCertificateVerify,
  verifyCertificateVerify,
} from "../../cipher/tls13/signature";
import { HandshakeType } from "../../handshake/const";
import {
  CookieExtension,
  cookieBinding,
  mintCookie,
  verifyCookie,
} from "../../handshake/extensions/cookie";
import { EllipticCurves } from "../../handshake/extensions/ellipticCurves";
import { KeyShare } from "../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { ClientHello } from "../../handshake/message/client/hello";
import { Finished } from "../../handshake/message/finished";
import { ServerHello } from "../../handshake/message/server/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { Certificate13 } from "../../handshake/message/tls13/certificate";
import { CertificateRequest13 } from "../../handshake/message/tls13/certificateRequest";
import { CertificateVerify13 } from "../../handshake/message/tls13/certificateVerify";
import { EncryptedExtensions } from "../../handshake/message/tls13/encryptedExtensions";
import { KeyUpdate } from "../../handshake/message/tls13/keyUpdate";
import { DtlsRandom } from "../../handshake/random";
import type { SrtpProfile } from "../../imports/rtp";
import { AlertDesc, ContentType } from "../../record/const";
import type { FragmentedHandshake } from "../../record/message/fragment";
import {
  createEpochProtection,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import type { Extension } from "../../typings/domain";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsProtocolError,
  DtlsVersion,
  DtlsVersionSelected,
  ProtocolVersionError,
  WireVersion,
  peerVersionsFromSupportedVersionsWire,
  protocolVersionsToWire,
  selectVersion,
  supportsVersion,
} from "../../version";
import { Dtls13RecordRx } from "./record-rx";
import { HandshakeTranscript } from "./transcript";
import { HRR_RANDOM, log } from "./types";

/** TLS 1.3 extension type padding (RFC 7685) — may change after HRR. */
const EXT_PADDING = 21;
/** TLS 1.3 early_data — must be removed in ClientHello2 if present in CH1. */
const EXT_EARLY_DATA = 42;

/** ServerHello (final) allowed extensions when PSK is not negotiated. */
const SERVER_HELLO_ALLOWED_EXTS = new Set([
  SupportedVersions.type,
  KeyShare.type,
]);
/** HelloRetryRequest allowed extensions. */
const HRR_ALLOWED_EXTS = new Set([
  SupportedVersions.type,
  KeyShare.type,
  CookieExtension.type,
]);
/**
 * Known extensions that are legal in EncryptedExtensions (TLS 1.3 registry).
 * Known types outside this set in EE → illegal_parameter.
 */
const EE_KNOWN_ALLOWED_EXTS = new Set([
  EllipticCurves.type, // 10 supported_groups (CH, EE)
  UseSRTP.type, // 14 use_srtp (CH, EE)
]);
/** Known TLS 1.3 extension types we parse (for wrong-message rejection). */
const KNOWN_EXTENSION_TYPES = new Set([
  EllipticCurves.type, // 10 supported_groups
  SignatureAlgorithms.type, // 13
  UseSRTP.type, // 14
  EXT_PADDING, // 21
  SupportedVersions.type, // 43
  CookieExtension.type, // 44
  KeyShare.type, // 51
  EXT_EARLY_DATA, // 42
]);

/**
 * RFC 8446: There MUST NOT be more than one extension of the same type
 * in a given extension block.
 */
function assertUniqueExtensions(
  extensions: { type: number }[],
  context: string,
): void {
  const seen = new Set<number>();
  for (const e of extensions) {
    if (seen.has(e.type)) {
      throw new DtlsProtocolError(
        `illegal_parameter: duplicate extension 0x${e.type.toString(16)} in ${context}`,
        AlertDesc.IllegalParameter,
      );
    }
    seen.add(e.type);
  }
}

/**
 * Handshake message handlers ordered like index.ts Figure 3 flights:
 *   Flight 1/3 ClientHello → Flight 2 HRR* → Flight 4 server → Flight 5 client → post-HS KeyUpdate
 */
export abstract class Dtls13HandshakeFlights extends Dtls13RecordRx {
  protected async dispatchHandshake(
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
    );

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
        }
        break;
      case HandshakeType.certificate_request_13:
        if (this.role === "client") {
          await this.onCertificateRequest(body);
        }
        break;
      case HandshakeType.certificate_11:
        await this.onCertificate(body);
        break;
      case HandshakeType.certificate_verify_15:
        await this.onCertificateVerify(body);
        break;
      case HandshakeType.finished_20:
        await this.onFinished(body, epoch);
        break;
      case HandshakeType.key_update_24:
        this.onKeyUpdate(body);
        break;
      default:
        log("ignored handshake type", hs.msg_type);
    }
  }

  // --- Flight 1 / 3: ClientHello (index.ts Figure 3) ---
  protected async sendClientHello(hrrGroup?: number): Promise<void> {
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
    this.clientOfferedExtensionTypes = new Set(
      ch.extensions.map((e) => e.type),
    );
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

  protected buildClientHelloExtensions(): Extension[] {
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
      // MKI offered on the wire (empty MKI encoded as single 0 length byte historically)
      this.clientOfferedSrtpMki = Buffer.from([0x00]);
      exts.push(
        UseSRTP.create(this.options.srtpProfiles, this.clientOfferedSrtpMki)
          .extension,
      );
    }

    return exts;
  }

  // --- Flight 2: HelloRetryRequest (optional cookie / group) ---
  protected async sendHelloRetryRequest(
    group: number | undefined,
    withCookie: boolean,
    clientHelloBody: Buffer,
  ): Promise<void> {
    const hrrRandom = {
      gmt_unix_time: HRR_RANDOM.readUInt32BE(0),
      random_bytes: HRR_RANDOM.subarray(4),
    };
    const extensions: Extension[] = [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
    ];
    // Record HRR deltas for ClientHello2 validation (RFC 8446 §4.1.4)
    this.hrrHadCookie = withCookie;
    this.hrrSelectedGroup = group;
    if (group !== undefined) {
      extensions.push(KeyShare.forHelloRetryRequest(group).serverExtension);
    }
    if (withCookie) {
      const binding = cookieBinding(
        this.associationPeerKey(),
        clientHelloBody,
      );
      const cookie = mintCookie(this.cookieSecret, binding);
      this.tlsCookie = Buffer.from(cookie);
      this.cookieClientHelloHash = hashSha256(clientHelloBody);
      extensions.push(new CookieExtension(cookie).extension);
    }
    // DTLS 1.3: zero-length legacy_session_id (do not echo client session id)
    const hrr = new ServerHello(
      WireVersion.DTLS_1_2,
      hrrRandom,
      Buffer.alloc(0),
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      0,
      extensions,
    );
    // First HRR: message_seq 0. Subsequent HRR (rare): increment, never reset.
    if (this.awaitingHrr) {
      this.messageSeq += 1;
      // Transcript already has message_hash(CH1)+HRR1; append this CH then HRR2
      this.transcript.add(HandshakeType.client_hello_1, clientHelloBody);
    } else {
      this.messageSeq = 0;
      this.transcript = new HandshakeTranscript();
      this.transcript.replaceWithMessageHash(clientHelloBody);
    }
    hrr.messageSeq = this.messageSeq;

    const body = hrr.serialize();
    this.transcript.add(HandshakeType.server_hello_2, body);
    this.awaitingHrr = true;
    this.firstClientHelloBody = clientHelloBody;

    const frag = hrr.toFragment();
    frag.message_seq = this.messageSeq;
    await this.sendHandshakeFlight([frag], 0, true);
  }

  // --- Flight 1→4 server: process ClientHello ---
  protected async onClientHello(
    body: Buffer,
    messageSeq: number,
  ): Promise<void> {
    const ch = ClientHello.deSerialize(body);
    assertUniqueExtensions(ch.extensions, "ClientHello");

    // RFC 9147: legacy_version MUST be DTLS 1.2 (0xfefd)
    const chVer =
      ((ch.clientVersion.major & 0xff) << 8) | (ch.clientVersion.minor & 0xff);
    if (chVer !== DTLS_1_2_VERSION) {
      throw new DtlsProtocolError(
        `illegal_parameter: ClientHello.legacy_version 0x${chVer.toString(16)} must be 0xfefd`,
        AlertDesc.IllegalParameter,
      );
    }

    // RFC 9147 / TLS 1.3: compression_methods MUST be exactly [0]
    if (ch.compressionMethods.length !== 1 || ch.compressionMethods[0] !== 0) {
      throw new DtlsProtocolError(
        "illegal_parameter: ClientHello.compression_methods must be [0]",
        AlertDesc.IllegalParameter,
      );
    }

    // RFC 9147: DTLS 1.3 ClientHello.legacy_cookie MUST be zero-length
    if (ch.cookie.length !== 0) {
      await this.sendFatalAlert(AlertDesc.IllegalParameter);
      this.fail(
        new DtlsProtocolError(
          "illegal_parameter: DTLS 1.3 ClientHello legacy_cookie must be empty",
          AlertDesc.IllegalParameter,
        ),
      );
      return;
    }

    // RFC 9147: do not use TLS compatibility mode — never echo legacy_session_id
    // (always reply with zero-length session_id in HRR/ServerHello).
    this.sessionId = Buffer.alloc(0);

    // Cipher suite selection: must offer TLS_AES_128_GCM_SHA256 (0x1301)
    if (!ch.cipherSuites.includes(CipherSuite.TLS_AES_128_GCM_SHA256_0x1301)) {
      await this.sendFatalAlert(AlertDesc.HandshakeFailure);
      this.fail(
        new DtlsProtocolError(
          "handshake_failure: ClientHello does not offer TLS_AES_128_GCM_SHA256",
          AlertDesc.HandshakeFailure,
        ),
      );
      return;
    }

    // After HRR: CH2 must match CH1 except allowed deltas (RFC 8446 §4.1.4)
    if (this.awaitingHrr && this.firstClientHelloBody) {
      this.validateClientHelloAfterHrr(this.firstClientHelloBody, ch, body);
    }

    // Track offered extensions for EncryptedExtensions allowlist
    this.clientOfferedExtensionTypes = new Set(
      ch.extensions.map((e) => e.type),
    );

    const versionsExt = ch.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!versionsExt) {
      await this.sendProtocolVersionAlert();
      return;
    }
    const sv = SupportedVersions.fromData(versionsExt.data, false);
    // Engine is DTLS 1.3: require peer to include 1.3 in supported_versions
    const peerVersions = peerVersionsFromSupportedVersionsWire(sv.versions);
    try {
      const selected = selectVersion(
        this.offeredProtocolVersions.length
          ? this.offeredProtocolVersions
          : [DtlsVersion.V1_3],
        peerVersions,
      );
      if (selected !== DtlsVersion.V1_3) {
        await this.sendProtocolVersionAlert();
        return;
      }
    } catch {
      await this.sendProtocolVersionAlert();
      return;
    }
    if (!sv.versions.includes(DTLS_1_3_VERSION)) {
      await this.sendProtocolVersionAlert();
      return;
    }

    // First acceptable DTLS 1.3 ClientHello → promote temporary source to peer.
    // Garbage UDP never reaches here, so cannot lock the association out.
    this.acceptAssociationPeer();

    // signature_algorithms is mandatory for certificate authentication (RFC 8446 §4.2.3)
    const sigExt = ch.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    if (!sigExt) {
      throw new DtlsProtocolError(
        "missing_extension: ClientHello missing signature_algorithms",
        AlertDesc.MissingExtension,
      );
    }
    try {
      const schemes = SignatureAlgorithms.fromData(sigExt.data).schemes;
      if (!schemes.length) {
        throw new DtlsProtocolError(
          "missing_extension: ClientHello signature_algorithms empty",
          AlertDesc.MissingExtension,
        );
      }
      this.peerSignatureSchemes = schemes;
    } catch (e) {
      if (e instanceof DtlsProtocolError) throw e;
      throw new DtlsProtocolError(
        "decode_error: ClientHello signature_algorithms invalid",
        AlertDesc.DecodeError,
      );
    }

    // supported_groups is mandatory for (EC)DHE (RFC 8446 §9.2 / §4.2.7)
    const sgExt = ch.extensions.find((e) => e.type === EllipticCurves.type);
    if (!sgExt) {
      throw new DtlsProtocolError(
        "missing_extension: ClientHello missing supported_groups",
        AlertDesc.MissingExtension,
      );
    }
    let clientSupportedGroups: number[];
    try {
      clientSupportedGroups = EllipticCurves.fromData(sgExt.data).data;
    } catch {
      throw new DtlsProtocolError(
        "decode_error: ClientHello supported_groups invalid",
        AlertDesc.DecodeError,
      );
    }
    if (!clientSupportedGroups.length) {
      throw new DtlsProtocolError(
        "missing_extension: ClientHello supported_groups empty",
        AlertDesc.MissingExtension,
      );
    }
    const groupIntersection = this.groups.filter((g) =>
      clientSupportedGroups.includes(g),
    );
    if (groupIntersection.length === 0) {
      throw new DtlsProtocolError(
        "handshake_failure: no overlapping named groups (supported_groups ∩ server groups empty)",
        AlertDesc.HandshakeFailure,
      );
    }

    // key_share is mandatory for (EC)DHE ClientHello (RFC 8446 §9.2)
    const keyShareExt = ch.extensions.find((e) => e.type === KeyShare.type);
    if (!keyShareExt) {
      throw new DtlsProtocolError(
        "missing_extension: ClientHello missing key_share",
        AlertDesc.MissingExtension,
      );
    }
    const ks = KeyShare.fromClientData(keyShareExt.data);
    // Accept only shares in the intersection (not merely server groups)
    const clientShare = ks.clientShares?.find((s) =>
      groupIntersection.includes(s.group as NamedCurveAlgorithms),
    );
    // HRR selected_group: first intersection group not already in client key_share
    const offeredShareGroups = new Set(
      (ks.clientShares ?? []).map((s) => s.group),
    );
    const hrrGroupCandidate = groupIntersection.find(
      (g) => !offeredShareGroups.has(g),
    );
    const needGroupHrr = !clientShare;
    if (needGroupHrr && hrrGroupCandidate === undefined) {
      throw new DtlsProtocolError(
        "handshake_failure: client key_share has no acceptable group and no HRR candidate in intersection",
        AlertDesc.HandshakeFailure,
      );
    }

    // Address validation via TLS cookie (HRR), bound to peer + first ClientHello.
    // When cookie and group selection both needed, emit a *single* combined HRR
    // so the client never sees a second HRR with message_seq=0 (duplicate drop).
    if (this.addressValidation === "dtls-cookie" && !this.addressValidated) {
      const cookieExt = ch.extensions.find(
        (e) => e.type === CookieExtension.type,
      );
      if (!cookieExt) {
        this.firstClientHelloBody = body;
        this.cookieClientHelloHash = hashSha256(body);
        if (this.hrrCount >= 1) {
          throw new DtlsProtocolError(
            "second HelloRetryRequest not allowed",
            AlertDesc.UnexpectedMessage,
          );
        }
        this.hrrCount += 1;
        await this.sendHelloRetryRequest(
          needGroupHrr ? hrrGroupCandidate : undefined,
          true,
          body,
        );
        return;
      }
      const cookie = CookieExtension.fromData(cookieExt.data).cookie;
      // Binding must use the first ClientHello (mint-time), not the second
      const chForBind = this.firstClientHelloBody ?? body;
      const binding = cookieBinding(this.associationPeerKey(), chForBind);
      if (!verifyCookie(this.cookieSecret, cookie, binding)) {
        throw new DtlsProtocolError(
          "invalid DTLS cookie (peer address or ClientHello binding mismatch)",
          AlertDesc.HandshakeFailure,
        );
      }
      this.addressValidated = true;
      this.tlsCookie = Buffer.from(cookie);
      // Cookie validates the remote address — pin so other 5-tuples cannot hijack TX
      this.pinPeer(this.associationPeerKey(), this.getSendAddr());
    }

    if (needGroupHrr) {
      this.firstClientHelloBody = this.firstClientHelloBody ?? body;
      if (this.hrrCount >= 1) {
        throw new DtlsProtocolError(
          "second HelloRetryRequest not allowed",
          AlertDesc.UnexpectedMessage,
        );
      }
      this.hrrCount += 1;
      await this.sendHelloRetryRequest(hrrGroupCandidate, false, body);
      return;
    }

    this.remoteKeyShare = clientShare;
    this.selectedGroup = clientShare.group as NamedCurveAlgorithms;
    this.localKeyPair = generateKeyPair(this.selectedGroup);
    this.clientRandom = DtlsRandom.from(ch.random as any);
    // sessionId stays zero-length for DTLS 1.3 (no echo)
    // Server message_seq: first ServerHello is 0; after HRR (already 0) continue at 1
    if (!this.awaitingHrr) {
      this.messageSeq = -1; // sendServerFlight does +=1 → ServerHello seq 0
    }
    // if post-HRR, messageSeq remains 0 from HRR; sendServerFlight +=1 → SH seq 1

    // use_srtp (RFC 5764): strict decode; pick one mutually supported profile
    const srtpExt = ch.extensions.find((e) => e.type === UseSRTP.type);
    if (srtpExt) {
      let use: UseSRTP;
      try {
        use = UseSRTP.fromData(srtpExt.data);
      } catch (e) {
        throw new DtlsProtocolError(
          `decode_error: malformed use_srtp in ClientHello: ${e instanceof Error ? e.message : String(e)}`,
          AlertDesc.DecodeError,
        );
      }
      if (!use.profiles.length) {
        throw new DtlsProtocolError(
          "illegal_parameter: use_srtp profiles empty in ClientHello",
          AlertDesc.IllegalParameter,
        );
      }
      // Store client MKI for EE response echo check
      this.clientOfferedSrtpMki = Buffer.from(use.mki ?? Buffer.alloc(0));
      if (this.options.srtpProfiles?.length) {
        const match = use.profiles.find((p) =>
          this.options.srtpProfiles!.includes(p as SrtpProfile),
        );
        if (match !== undefined) {
          this.negotiatedSrtpProfile = match;
        }
        // No shared profile: omit use_srtp from EE (do not abort handshake)
      }
    }

    // Transcript after HRR: message_hash(CH1) + HRR already set; else fresh CH
    // Do NOT touch nextReceiveSeq here — enqueueHandshake owns it (avoids double-increment).
    if (this.awaitingHrr && this.firstClientHelloBody) {
      // second CH after HRR — transcript already has message_hash + HRR
      this.transcript.add(HandshakeType.client_hello_1, body);
      this.awaitingHrr = false;
    } else {
      this.transcript = new HandshakeTranscript();
      this.transcript.add(HandshakeType.client_hello_1, body);
    }

    await this.sendServerFlight();
  }

  /**
   * After HRR, ClientHello2 must match ClientHello1 except RFC 8446 §4.1.4
   * allowed deltas driven by the actual HRR contents:
   * - key_share: only if HRR contained selected_group
   * - cookie: only if HRR contained cookie (then CH2 must include it)
   * - early_data: if present in CH1 must be removed; cannot newly appear
   * - padding: may be added/removed/changed freely
   */
  protected validateClientHelloAfterHrr(
    ch1Body: Buffer,
    ch2: ClientHello,
    _ch2Body: Buffer,
  ): void {
    const ch1 = ClientHello.deSerialize(ch1Body);
    const fail = (msg: string): never => {
      throw new DtlsProtocolError(msg, AlertDesc.IllegalParameter);
    };

    // legacy_version
    if (
      ch1.clientVersion.major !== ch2.clientVersion.major ||
      ch1.clientVersion.minor !== ch2.clientVersion.minor
    ) {
      fail("illegal_parameter: ClientHello2 legacy_version differs from CH1");
    }
    // random MUST be identical
    const r1 = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(ch1.random.gmt_unix_time >>> 0, 0);
        return b;
      })(),
      ch1.random.random_bytes,
    ]);
    const r2 = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(ch2.random.gmt_unix_time >>> 0, 0);
        return b;
      })(),
      ch2.random.random_bytes,
    ]);
    if (!r1.equals(r2)) {
      fail("illegal_parameter: ClientHello2 random differs from ClientHello1");
    }
    // legacy_session_id
    if (!Buffer.from(ch1.sessionId).equals(Buffer.from(ch2.sessionId))) {
      fail(
        "illegal_parameter: ClientHello2 legacy_session_id differs from ClientHello1",
      );
    }
    if (ch2.cookie.length !== 0) {
      fail(
        "illegal_parameter: DTLS 1.3 ClientHello2 legacy_cookie must be empty",
      );
    }
    // cipher_suites must be identical
    if (
      ch1.cipherSuites.length !== ch2.cipherSuites.length ||
      ch1.cipherSuites.some((c, i) => c !== ch2.cipherSuites[i])
    ) {
      fail(
        "illegal_parameter: ClientHello2 cipher_suites differ from ClientHello1",
      );
    }
    // compression_methods identical
    if (
      ch1.compressionMethods.length !== ch2.compressionMethods.length ||
      ch1.compressionMethods.some((c, i) => c !== ch2.compressionMethods[i])
    ) {
      fail(
        "illegal_parameter: ClientHello2 compression_methods differ from ClientHello1",
      );
    }

    const mapExts = (exts: { type: number; data: Buffer }[]) => {
      const m = new Map<number, Buffer>();
      for (const e of exts) m.set(e.type, e.data);
      return m;
    };
    const m1 = mapExts(ch1.extensions);
    const m2 = mapExts(ch2.extensions);

    // early_data: may only be removed, never added or kept after HRR
    if (m2.has(EXT_EARLY_DATA)) {
      fail(
        "illegal_parameter: ClientHello2 must not contain early_data after HRR",
      );
    }

    // cookie: required iff HRR had cookie; forbidden to invent otherwise
    if (this.hrrHadCookie) {
      if (!m2.has(CookieExtension.type)) {
        fail(
          "illegal_parameter: ClientHello2 missing cookie required by HelloRetryRequest",
        );
      }
    } else if (m2.has(CookieExtension.type) && !m1.has(CookieExtension.type)) {
      fail(
        "illegal_parameter: ClientHello2 added cookie without HelloRetryRequest cookie",
      );
    }

    // key_share: only changeable when HRR selected_group was present
    if (this.hrrSelectedGroup !== undefined) {
      if (!m2.has(KeyShare.type)) {
        fail(
          "illegal_parameter: ClientHello2 missing key_share after HRR selected_group",
        );
      }
      // RFC 8446 §4.1.4: replace with a single KeyShareEntry for selected_group
      let shares: { group: number }[] = [];
      try {
        shares =
          KeyShare.fromClientData(m2.get(KeyShare.type)!).clientShares ?? [];
      } catch {
        fail("illegal_parameter: ClientHello2 key_share malformed after HRR");
      }
      if (shares.length !== 1 || shares[0].group !== this.hrrSelectedGroup) {
        fail(
          `illegal_parameter: ClientHello2 key_share must be a single entry for HRR selected_group 0x${this.hrrSelectedGroup.toString(16)}`,
        );
      }
    } else {
      // Must be identical to CH1
      const k1 = m1.get(KeyShare.type);
      const k2 = m2.get(KeyShare.type);
      if (!k1 || !k2 || !k1.equals(k2)) {
        fail(
          "illegal_parameter: ClientHello2 key_share changed without HRR selected_group",
        );
      }
    }

    // All other extensions (except padding / early_data / cookie / key_share
    // under the rules above) must be identical in type set and contents.
    const skipCompare = new Set<number>([EXT_PADDING, EXT_EARLY_DATA]);
    if (this.hrrSelectedGroup !== undefined) skipCompare.add(KeyShare.type);
    // cookie may be newly added when HRR had cookie
    if (this.hrrHadCookie || m1.has(CookieExtension.type)) {
      skipCompare.add(CookieExtension.type);
    }

    const types1 = [...m1.keys()].filter((t) => !skipCompare.has(t)).sort();
    const types2 = [...m2.keys()].filter((t) => !skipCompare.has(t)).sort();
    if (
      types1.length !== types2.length ||
      types1.some((t, i) => t !== types2[i])
    ) {
      fail(
        "illegal_parameter: ClientHello2 extension set differs from ClientHello1",
      );
    }
    for (const t of types1) {
      const d1 = m1.get(t)!;
      const d2 = m2.get(t)!;
      if (!d1.equals(d2)) {
        fail(
          `illegal_parameter: ClientHello2 extension 0x${t.toString(16)} differs from ClientHello1`,
        );
      }
    }
  }

  /**
   * HelloRetryRequest. Optionally includes cookie for address validation
   * and/or selected_group for key_share. Combined cookie+group HRR avoids a
   * second message_seq=0 HRR that clients would treat as a duplicate.
   */

  // --- Flight 4: ServerHello + encrypted server flight ---
  protected async sendServerFlight(): Promise<void> {
    // ServerHello (plaintext epoch 0)
    this.serverRandom = new DtlsRandom();
    const shExtensions: Extension[] = [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
      KeyShare.forServer({
        group: this.selectedGroup,
        keyExchange: this.localKeyPair.publicKey,
      }).serverExtension,
    ];
    // use_srtp is carried in EncryptedExtensions (TLS 1.3), not ServerHello

    // DTLS 1.3: zero-length legacy_session_id (RFC 9147 — no TLS compatibility mode)
    const sh = new ServerHello(
      WireVersion.DTLS_1_2,
      this.serverRandom,
      Buffer.alloc(0),
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      0,
      shExtensions,
    );
    this.messageSeq += 1;
    sh.messageSeq = this.messageSeq;
    const shBody = sh.serialize();
    this.transcript.add(HandshakeType.server_hello_2, shBody);

    // ECDHE
    const shared = prfPreMasterSecret(
      this.remoteKeyShare!.keyExchange,
      this.localKeyPair.privateKey,
      this.selectedGroup,
    );
    const hsSecrets = this.keySchedule.deriveHandshakeSecrets(
      shared,
      this.transcript.bytes,
    );
    this.handshakeSecret = hsSecrets.handshakeSecret;
    this.clientHsTraffic = hsSecrets.clientHandshakeTrafficSecret;
    this.serverHsTraffic = hsSecrets.serverHandshakeTrafficSecret;

    // Install epoch 2 keys
    const ep2 = createEpochProtection(2);
    ep2.writeKeys = this.keySchedule.trafficKeys(this.serverHsTraffic);
    ep2.readKeys = this.keySchedule.trafficKeys(this.clientHsTraffic);
    this.installEpoch(2, ep2);
    this.writeEpoch = 2;
    this.readEpoch = 2;

    // EncryptedExtensions (may include use_srtp)
    const eeExts: Extension[] = [];
    if (this.negotiatedSrtpProfile !== undefined) {
      // RFC 5764: single selected profile; MKI must match client offer
      eeExts.push(
        UseSRTP.create(
          [this.negotiatedSrtpProfile as SrtpProfile],
          Buffer.from(this.clientOfferedSrtpMki),
        ).extension,
      );
    }
    const ee = new EncryptedExtensions(eeExts);
    this.messageSeq += 1;
    ee.messageSeq = this.messageSeq;
    const eeBody = ee.serialize();
    this.transcript.add(HandshakeType.encrypted_extensions_8, eeBody);

    const encFragsList: FragmentedHandshake[] = [];

    // Optional CertificateRequest for mutual auth
    if (this.options.certificateRequest) {
      // RFC 8446 §4.3.2: certificate_request_context MUST be zero-length in
      // the main handshake (non-zero only for post-handshake authentication).
      this.certificateRequestContext = Buffer.alloc(0);
      this.expectClientCertificate = true;
      // Advertise schemes we accept for client CertificateVerify
      this.certificateRequestSignatureSchemes = [
        ...this.localOfferedSignatureSchemes,
      ];
      const cr = CertificateRequest13.create(
        this.certificateRequestContext,
        this.certificateRequestSignatureSchemes,
      );
      this.messageSeq += 1;
      cr.messageSeq = this.messageSeq;
      this.transcript.add(HandshakeType.certificate_request_13, cr.serialize());
      const crf = cr.toFragment();
      crf.message_seq = cr.messageSeq;
      encFragsList.push(crf);
    }

    // Certificate
    const cert = new Certificate13(Buffer.alloc(0), [this.certDer]);
    this.messageSeq += 1;
    cert.messageSeq = this.messageSeq;
    const certBody = cert.serialize();
    this.transcript.add(HandshakeType.certificate_11, certBody);
    {
      const f = cert.toFragment();
      f.message_seq = cert.messageSeq;
      encFragsList.push(f);
    }

    // CertificateVerify: peer ClientHello signature_algorithms ∩ local key
    let serverCvScheme: number;
    try {
      serverCvScheme = selectSignatureScheme(
        this.keyPem,
        this.peerSignatureSchemes,
      );
    } catch (e) {
      throw new DtlsProtocolError(
        e instanceof Error ? e.message : String(e),
        AlertDesc.HandshakeFailure,
      );
    }
    const { algorithm, signature } = signCertificateVerify(
      this.keyPem,
      true,
      this.transcript.bytes,
      serverCvScheme,
    );
    const cv = new CertificateVerify13(algorithm, signature);
    this.messageSeq += 1;
    cv.messageSeq = this.messageSeq;
    const cvBody = cv.serialize();
    this.transcript.add(HandshakeType.certificate_verify_15, cvBody);
    {
      const f = cv.toFragment();
      f.message_seq = cv.messageSeq;
      encFragsList.push(f);
    }

    // Finished
    const verifyData = this.keySchedule.verifyData(
      this.serverHsTraffic,
      this.transcript.bytes,
    );
    const fin = new Finished(verifyData);
    this.messageSeq += 1;
    fin.messageSeq = this.messageSeq;
    const finBody = fin.serialize();
    this.transcript.add(HandshakeType.finished_20, finBody);
    {
      const f = fin.toFragment();
      f.message_seq = fin.messageSeq;
      encFragsList.push(f);
    }

    // EncryptedExtensions first in the encrypted flight (use_srtp lives here, not SH)
    {
      const f = ee.toFragment();
      f.message_seq = ee.messageSeq!;
      encFragsList.unshift(f);
    }

    // Derive application secrets after server Finished is in transcript
    const appSecrets = this.keySchedule.deriveApplicationSecrets(
      this.handshakeSecret!,
      this.transcript.bytes,
    );
    this.clientAppTraffic = appSecrets.clientApplicationTrafficSecret;
    this.serverAppTraffic = appSecrets.serverApplicationTrafficSecret;
    this.exporterMasterSecret = appSecrets.exporterMasterSecret;

    // Epoch 3: install both directions after server Finished so reordered
    // epoch-3 records (ACK / early app data) can decrypt; app delivery gated on connected.
    const ep3 = createEpochProtection(3);
    ep3.writeKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
    ep3.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic!);
    this.installEpoch(3, ep3);

    // Send ServerHello in epoch 0, then encrypted messages in epoch 2.
    // Keep SH for retransmit alongside the encrypted flight until ACK.
    const shFrag = sh.toFragment();
    shFrag.message_seq = sh.messageSeq!;
    const shBytes = serializePlaintextRecord(
      ContentType.handshake,
      0,
      this.recordSeqEpoch0++,
      shFrag.serialize(),
    );
    this.pendingServerHello = createHandshakeDatagram(
      shBytes,
      this.flightId + 1,
      0,
      true,
    );
    // Budget-checked (same anti-amp path as flights / ACK / alerts)
    if (!this.consumeSendBudget(shBytes.length)) {
      throw new Error("anti-amplification: budget exhausted for ServerHello");
    }
    await this.carrier.send(this.pendingServerHello, this.getSendAddr());

    await this.sendHandshakeFlight(encFragsList, 2, true);
    this.localFinishedSent = true;
    this.serverFlightComplete = true;
    // Server can send early app data on epoch 3 after its Finished (WARP); optional
    this.writeEpoch = 3;
  }

  // --- Flight 4 receive (client): ServerHello → ... ---
  protected async onServerHello(
    body: Buffer,
    messageSeq: number,
  ): Promise<void> {
    const sh = ServerHello.deSerialize(body);
    this.messageSeq = messageSeq;
    assertUniqueExtensions(sh.extensions, "ServerHello");

    // RFC 9147: ServerHello.legacy_version MUST be DTLS 1.2 (0xfefd)
    const shVer =
      ((sh.serverVersion.major & 0xff) << 8) | (sh.serverVersion.minor & 0xff);
    if (shVer !== DTLS_1_2_VERSION) {
      throw new DtlsProtocolError(
        `illegal_parameter: ServerHello.legacy_version 0x${shVer.toString(16)} must be 0xfefd`,
        AlertDesc.IllegalParameter,
      );
    }
    // TLS 1.3: compression_method MUST be 0
    if (sh.compressionMethod !== 0) {
      throw new DtlsProtocolError(
        "illegal_parameter: ServerHello.compression_method must be 0",
        AlertDesc.IllegalParameter,
      );
    }
    // DTLS 1.3: we send empty legacy_session_id; server must echo empty
    if (
      !Buffer.from(sh.sessionId).equals(
        Buffer.from(this.sessionId ?? Buffer.alloc(0)),
      )
    ) {
      throw new DtlsProtocolError(
        "illegal_parameter: ServerHello.legacy_session_id does not match ClientHello",
        AlertDesc.IllegalParameter,
      );
    }

    // Detect HRR by random
    const randomBuf = Buffer.concat([
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
        return b;
      })(),
      sh.random.random_bytes,
    ]);
    const isHrr = randomBuf.equals(HRR_RANDOM);

    // Extension allowlist (PSK not supported)
    const allowed = isHrr ? HRR_ALLOWED_EXTS : SERVER_HELLO_ALLOWED_EXTS;
    for (const ext of sh.extensions) {
      if (!allowed.has(ext.type)) {
        throw new DtlsProtocolError(
          `illegal_parameter: extension 0x${ext.type.toString(16)} not allowed in ${isHrr ? "HelloRetryRequest" : "ServerHello"}`,
          AlertDesc.IllegalParameter,
        );
      }
    }

    const versionsExt = sh.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!versionsExt) {
      throw new ProtocolVersionError("ServerHello missing supported_versions");
    }
    const selected = SupportedVersions.fromData(versionsExt.data, true)
      .selected!;
    if (selected !== DTLS_1_3_VERSION) {
      throw new ProtocolVersionError(
        `server selected unsupported version 0x${selected.toString(16)}`,
      );
    }

    // Acceptable DTLS 1.3 ServerHello / HRR → bind association peer
    this.acceptAssociationPeer();

    if (isHrr) {
      // RFC 8446 §4.1.4: at most one HRR; selected_group must be newly offered
      if (this.hrrCount >= 1) {
        throw new DtlsProtocolError(
          "second HelloRetryRequest not allowed",
          AlertDesc.UnexpectedMessage,
        );
      }
      this.hrrCount += 1;
      // Cipher suite must be one we offered
      if (sh.cipherSuite !== CipherSuite.TLS_AES_128_GCM_SHA256_0x1301) {
        throw new DtlsProtocolError(
          `HRR cipher suite 0x${sh.cipherSuite.toString(16)} not offered`,
          AlertDesc.IllegalParameter,
        );
      }
      this.hrrCipherSuite = sh.cipherSuite;

      const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
      const group = ksExt
        ? KeyShare.fromServerData(ksExt.data).selectedGroup
        : undefined;
      if (group !== undefined) {
        if (!this.groups.includes(group as NamedCurveAlgorithms)) {
          throw new DtlsProtocolError(
            `HRR selected_group 0x${group.toString(16)} not in client supported_groups`,
            AlertDesc.IllegalParameter,
          );
        }
        if (this.initialKeyShareGroups.includes(group)) {
          throw new DtlsProtocolError(
            `HRR selected_group 0x${group.toString(16)} was already in initial key_share`,
            AlertDesc.IllegalParameter,
          );
        }
      }
      const cookieExt = sh.extensions.find(
        (e) => e.type === CookieExtension.type,
      );
      if (cookieExt) {
        this.tlsCookie = Buffer.from(
          CookieExtension.fromData(cookieExt.data).cookie,
        );
      }
      // Record HRR deltas for any local CH2 rules / diagnostics
      this.hrrHadCookie = !!cookieExt;
      this.hrrSelectedGroup = group;
      // HRR must cause a change to the subsequent ClientHello (cookie and/or group)
      if (!cookieExt && group === undefined) {
        throw new DtlsProtocolError(
          "illegal_parameter: HelloRetryRequest does not change ClientHello",
          AlertDesc.IllegalParameter,
        );
      }
      // Transcript: replace first CH with message_hash, add HRR
      if (this.firstClientHelloBody) {
        this.transcript = new HandshakeTranscript();
        this.transcript.replaceWithMessageHash(this.firstClientHelloBody);
      }
      this.transcript.add(HandshakeType.server_hello_2, body);
      this.awaitingHrr = true;
      await this.sendClientHello(group);
      return;
    }

    if (sh.cipherSuite !== CipherSuite.TLS_AES_128_GCM_SHA256_0x1301) {
      throw new DtlsProtocolError(
        `unsupported cipher suite 0x${sh.cipherSuite.toString(16)}`,
        AlertDesc.HandshakeFailure,
      );
    }
    // After HRR, final ServerHello cipher suite must match HRR selection
    if (
      this.hrrCipherSuite !== undefined &&
      sh.cipherSuite !== this.hrrCipherSuite
    ) {
      throw new DtlsProtocolError(
        `ServerHello cipher suite 0x${sh.cipherSuite.toString(16)} does not match HRR 0x${this.hrrCipherSuite.toString(16)}`,
        AlertDesc.IllegalParameter,
      );
    }

    const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
    if (!ksExt) {
      throw new DtlsProtocolError(
        "ServerHello missing key_share",
        AlertDesc.MissingExtension,
      );
    }
    const serverShare = KeyShare.fromServerData(ksExt.data).serverShare!;
    // RFC 8446: server_share.group must match the KeyShareEntry the client sent
    // in the (post-HRR) ClientHello — tracked as this.selectedGroup.
    if (serverShare.group !== this.selectedGroup) {
      throw new DtlsProtocolError(
        `ServerHello key_share group 0x${serverShare.group.toString(16)} does not match offered 0x${this.selectedGroup.toString(16)}`,
        AlertDesc.IllegalParameter,
      );
    }
    this.remoteKeyShare = serverShare;
    this.serverRandom = DtlsRandom.from(sh.random as any);
    // Client continues its own message_seq after ClientHello (0)
    // messageSeq currently reflects last received server seq; keep local counter for sends
    if (this.messageSeq < 0) this.messageSeq = 0;

    this.transcript.add(HandshakeType.server_hello_2, body);

    // Stop ClientHello retransmission; we are past flight 1
    this.clearPendingFlight();

    const shared = prfPreMasterSecret(
      serverShare.keyExchange,
      this.localKeyPair.privateKey,
      this.selectedGroup,
    );
    const hsSecrets = this.keySchedule.deriveHandshakeSecrets(
      shared,
      this.transcript.bytes,
    );
    this.handshakeSecret = hsSecrets.handshakeSecret;
    this.clientHsTraffic = hsSecrets.clientHandshakeTrafficSecret;
    this.serverHsTraffic = hsSecrets.serverHandshakeTrafficSecret;

    const ep2 = createEpochProtection(2);
    ep2.writeKeys = this.keySchedule.trafficKeys(this.clientHsTraffic);
    ep2.readKeys = this.keySchedule.trafficKeys(this.serverHsTraffic);
    this.installEpoch(2, ep2);
    this.readEpoch = 2;
    this.writeEpoch = 2;
    this.clientExpectsServerFlight = true;
  }

  protected async onEncryptedExtensions(body: Buffer): Promise<void> {
    const ee = EncryptedExtensions.deSerialize(body);
    assertUniqueExtensions(ee.extensions, "EncryptedExtensions");
    // RFC 8446:
    // 1) Any extension not offered in ClientHello → unsupported_extension
    // 2) Recognized but not legal in EE → illegal_parameter
    // 3) Unrecognized but offered → ignore content
    for (const ext of ee.extensions) {
      if (!this.clientOfferedExtensionTypes.has(ext.type)) {
        throw new DtlsProtocolError(
          `unsupported_extension: unsolicited extension 0x${ext.type.toString(16)} in EncryptedExtensions`,
          AlertDesc.UnsupportedExtension,
        );
      }
      if (
        KNOWN_EXTENSION_TYPES.has(ext.type) &&
        !EE_KNOWN_ALLOWED_EXTS.has(ext.type)
      ) {
        throw new DtlsProtocolError(
          `illegal_parameter: extension 0x${ext.type.toString(16)} forbidden in EncryptedExtensions`,
          AlertDesc.IllegalParameter,
        );
      }
    }
    // Negotiate use_srtp from EncryptedExtensions (TLS 1.3 / RFC 5764).
    const srtpExt = ee.extensions.find((e) => e.type === UseSRTP.type);
    if (srtpExt) {
      if (!this.options.srtpProfiles?.length) {
        throw new DtlsProtocolError(
          "unsupported_extension: unsolicited use_srtp in EncryptedExtensions",
          AlertDesc.UnsupportedExtension,
        );
      }
      let use: UseSRTP;
      try {
        use = UseSRTP.fromData(srtpExt.data);
      } catch (e) {
        throw new DtlsProtocolError(
          `decode_error: malformed use_srtp in EncryptedExtensions: ${e instanceof Error ? e.message : String(e)}`,
          AlertDesc.DecodeError,
        );
      }
      // RFC 5764: server response MUST contain exactly one ProtectionProfile
      if (use.profiles.length !== 1) {
        throw new DtlsProtocolError(
          `illegal_parameter: use_srtp server response must contain exactly one profile (got ${use.profiles.length})`,
          AlertDesc.IllegalParameter,
        );
      }
      const selected = use.profiles[0];
      if (!this.options.srtpProfiles.includes(selected as SrtpProfile)) {
        throw new DtlsProtocolError(
          `illegal_parameter: use_srtp profile 0x${selected.toString(16)} was not offered by client`,
          AlertDesc.IllegalParameter,
        );
      }
      // MKI in response must match what the client offered (RFC 5764)
      const respMki = Buffer.from(use.mki ?? Buffer.alloc(0));
      if (!respMki.equals(this.clientOfferedSrtpMki)) {
        throw new DtlsProtocolError(
          "illegal_parameter: use_srtp MKI in server response does not match ClientHello offer",
          AlertDesc.IllegalParameter,
        );
      }
      this.negotiatedSrtpProfile = selected;
    }
    this.transcript.add(HandshakeType.encrypted_extensions_8, body);
  }

  protected async onCertificateRequest(body: Buffer): Promise<void> {
    const cr = CertificateRequest13.deSerialize(body);
    assertUniqueExtensions(cr.extensions, "CertificateRequest");
    // Main handshake: context MUST be zero-length (post-handshake auth not supported)
    if (cr.certificateRequestContext.length !== 0) {
      throw new Error(
        "illegal_parameter: CertificateRequest.certificate_request_context must be empty in main handshake",
      );
    }
    // certificate_request_context must be echoed in client Certificate (RFC 8446 §4.3.2)
    this.certificateRequestContext = Buffer.from(cr.certificateRequestContext);
    this.peerRequestedClientCert = true;
    // signature_algorithms is MUST in CertificateRequest (RFC 8446 §4.3.2)
    const sigExt = cr.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    if (!sigExt) {
      throw new Error(
        "missing_extension: CertificateRequest requires signature_algorithms",
      );
    }
    try {
      const schemes = SignatureAlgorithms.fromData(sigExt.data).schemes;
      if (!schemes.length) {
        throw new Error("CertificateRequest signature_algorithms empty");
      }
      // Keep peer order for CertificateVerify selection; require intersection
      // only when we have a local cert to present.
      if (this.hasLocalIdentity) {
        const ok = schemes.some((s) =>
          this.localOfferedSignatureSchemes.includes(s),
        );
        if (!ok) {
          throw new Error(
            "no overlapping signature_algorithms with CertificateRequest",
          );
        }
      }
      this.certificateRequestSignatureSchemes = schemes;
      this.peerSignatureSchemes = schemes;
    } catch (e) {
      if (
        e instanceof Error &&
        /overlapping|empty|missing_extension/.test(e.message)
      ) {
        throw e;
      }
      throw new Error("CertificateRequest invalid signature_algorithms");
    }
    this.transcript.add(HandshakeType.certificate_request_13, body);
  }

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

  // --- Flight 4/5 Finished ---
  protected async onFinished(body: Buffer, epoch: number): Promise<void> {
    const fin = Finished.deSerialize(body);
    if (this.role === "client") {
      // Verify server Finished
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
      // RFC 8446: if no suitable cert, send empty Certificate and skip CV.
      const clientMsgs: FragmentedHandshake[] = [];
      if (this.peerRequestedClientCert) {
        if (this.hasLocalIdentity && this.certDer.length && this.keyPem) {
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
          const emptyCert = new Certificate13(
            this.certificateRequestContext,
            [],
          );
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
    } else {
      // Server receives client Finished — mutual auth policy
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
  }

  // --- Post-handshake: KeyUpdate + ACK gating ---
  protected onKeyUpdate(body: Buffer) {
    const ku = KeyUpdate.deSerialize(body);
    // Peer sent KeyUpdate under their old write keys (= our current read epoch).
    // Keep the previous epoch's readKeys installed for late retransmits; do NOT
    // overwrite writeEpoch.readKeys (that would clobber independent key state).
    // If next read epoch collides with a pending local KeyUpdate write epoch,
    // merge into the existing entry so writeKeys are not wiped.
    if (this.role === "client") {
      this.serverAppTraffic = this.keySchedule.updateTrafficSecret(
        this.serverAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.serverAppTraffic);
      this.installEpoch(nextEpoch, ep);
      this.readEpoch = nextEpoch;
    } else {
      this.clientAppTraffic = this.keySchedule.updateTrafficSecret(
        this.clientAppTraffic!,
      );
      const nextEpoch = this.nextAppEpoch(this.readEpoch);
      const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
      ep.readKeys = this.keySchedule.trafficKeys(this.clientAppTraffic);
      this.installEpoch(nextEpoch, ep);
      this.readEpoch = nextEpoch;
    }
    this.pruneStaleEpochs();
    // Same as Finished: RX layer notes this record, then sendAck() (RFC 9147 §8).
    // Do NOT sendAck here — the current KeyUpdate is not in the ACK list yet.
    this.ackAfterCurrentRecord = true;
    // Response KeyUpdate must not stand in for ACK; send only after we ACK peer.
    if (ku.requestUpdate) {
      this.keyUpdateResponseAfterAck = true;
    }
  }

  /** Next application epoch after KeyUpdate (skip reserved epoch 1). */
  protected nextAppEpoch(current: number): number {
    let n = current + 1;
    if (n === 1) n = 2;
    return n;
  }

  /** RFC 9147 post-handshake KeyUpdate (public). */

  async keyUpdate(requestUpdate = false): Promise<void> {
    if (!this.connected) throw new Error("not connected");
    if (this.pendingKeyUpdateWrite) {
      throw new Error("KeyUpdate already in progress; wait for peer ACK");
    }
    // RFC 9147 §8: send KeyUpdate under *current* write keys; do not send with
    // the new keys until this KeyUpdate flight is ACK'd.
    const sendEpoch = this.writeEpoch;
    const ku = new KeyUpdate(requestUpdate);
    this.messageSeq += 1;
    ku.messageSeq = this.messageSeq;
    const frag = ku.toFragment();
    frag.message_seq = ku.messageSeq;
    await this.sendHandshakeFlight([frag], sendEpoch, true);

    const currentTraffic =
      this.role === "client" ? this.clientAppTraffic! : this.serverAppTraffic!;
    const nextTrafficSecret =
      this.keySchedule.updateTrafficSecret(currentTraffic);
    const nextEpoch = this.nextAppEpoch(this.writeEpoch);
    // Install write keys only on the pending epoch. Do NOT copy old read keys
    // onto this write epoch — that mixes key directions across epochs and can
    // decrypt peer records under the wrong epoch during KeyUpdate races.
    // Read keys stay on readEpoch (or are installed by onKeyUpdate when the
    // peer advances their write).
    const ep = this.epochs.get(nextEpoch) ?? createEpochProtection(nextEpoch);
    ep.writeKeys = this.keySchedule.trafficKeys(nextTrafficSecret);
    // Preserve any readKeys already installed by a concurrent peer KeyUpdate
    // for the same epoch number; never invent them from the previous epoch.
    this.installEpoch(nextEpoch, ep);
    this.pendingKeyUpdateWrite = {
      nextWriteEpoch: nextEpoch,
      nextTrafficSecret,
    };
    // writeEpoch intentionally unchanged — app data still uses old keys
  }
}
