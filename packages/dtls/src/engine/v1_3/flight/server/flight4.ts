import { createHandshakeDatagram } from "../../../../carrier/direct";
import {
  CipherSuite,
  type NamedCurveAlgorithms,
} from "../../../../cipher/const";
import { generateKeyPair } from "../../../../cipher/namedCurve";
import { prfPreMasterSecret } from "../../../../cipher/prf";
import {
  selectSignatureScheme,
  signCertificateVerify,
} from "../../../../cipher/tls13/signature";
import { HandshakeType } from "../../../../handshake/const";
import {
  CookieExtension,
  clientHelloImmutableFieldsHash,
  verifyAddressCookie,
} from "../../../../handshake/extensions/cookie";
import { EllipticCurves } from "../../../../handshake/extensions/ellipticCurves";
import { KeyShare } from "../../../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../../../handshake/extensions/useSrtp";
import { ClientHello } from "../../../../handshake/message/client/hello";
import { Finished } from "../../../../handshake/message/finished";
import { ServerHello } from "../../../../handshake/message/server/hello";
import { Certificate13 } from "../../../../handshake/message/tls13/certificate";
import { CertificateRequest13 } from "../../../../handshake/message/tls13/certificateRequest";
import { CertificateVerify13 } from "../../../../handshake/message/tls13/certificateVerify";
import { EncryptedExtensions } from "../../../../handshake/message/tls13/encryptedExtensions";
import { DtlsRandom } from "../../../../handshake/random";
import type { SrtpProfile } from "../../../../imports/rtp";
import { AlertDesc, ContentType } from "../../../../record/const";
import type { FragmentedHandshake } from "../../../../record/message/fragment";
import {
  createEpochProtection,
  serializePlaintextRecord,
} from "../../../../record/v1_3/record";
import type { Extension } from "../../../../typings/domain";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsProtocolError,
  DtlsVersion,
  WireVersion,
  peerVersionsFromSupportedVersionsWire,
  selectVersion,
} from "../../../../version";
import { HandshakeTranscript } from "../../transcript";
import { EXT_EARLY_DATA, assertUniqueExtensions } from "../extensions";
import { Dtls13ServerFlight2 } from "./flight2";

/**
 * Flight 4 (server): process ClientHello, then send ServerHello + encrypted flight.
 */
export abstract class Dtls13ServerFlight4 extends Dtls13ServerFlight2 {
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
    // Throw only — never fail() here (pre-cookie spoofed source DoS).
    if (ch.cookie.length !== 0) {
      throw new DtlsProtocolError(
        "illegal_parameter: DTLS 1.3 ClientHello legacy_cookie must be empty",
        AlertDesc.IllegalParameter,
      );
    }

    // RFC 9147: do not use TLS compatibility mode — never echo legacy_session_id
    // (always reply with zero-length session_id in HRR/ServerHello).
    this.sessionId = Buffer.alloc(0);

    // Cookie (if any) is verified later; do NOT wipe other peers' pre-cookie
    // attempts when a new cookie-less CH arrives (stateless cookie + per-peer map).

    // Track offered extensions for EncryptedExtensions allowlist
    this.clientOfferedExtensionTypes = new Set(
      ch.extensions.map((e) => e.type),
    );

    // Budget this CH before any epoch-0 reply (version alert / HRR). Without
    // RX accounting, pre-cookie anti-amplification blocks protocol_version(70).
    // Do NOT acceptAssociationPeer() yet under dtls-cookie: a valid cookie-less
    // ClientHello must not permanently lock the association (return-routability).
    this.accountCurrentDatagramForAntiAmp();

    // Version negotiation MUST run before cipher-suite selection so a 1.2-only
    // ClientHello (often without 0x1301) gets protocol_version(70) rather than
    // handshake_failure. Pre-cookie path still does not fail() the association
    // (sendProtocolVersionAlert); alert is directed at currentPeerAddr.
    const versionsExt = ch.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!versionsExt) {
      await this.sendProtocolVersionAlert(this.currentPeerAddr);
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
        await this.sendProtocolVersionAlert(this.currentPeerAddr);
        return;
      }
    } catch {
      await this.sendProtocolVersionAlert(this.currentPeerAddr);
      return;
    }
    if (!sv.versions.includes(DTLS_1_3_VERSION)) {
      await this.sendProtocolVersionAlert(this.currentPeerAddr);
      return;
    }

    // Cipher suite selection: must offer TLS_AES_128_GCM_SHA256 (0x1301)
    // (after version check so 1.2-only peers get protocol_version, not suite fail)
    if (!ch.cipherSuites.includes(CipherSuite.TLS_AES_128_GCM_SHA256_0x1301)) {
      throw new DtlsProtocolError(
        "handshake_failure: ClientHello does not offer TLS_AES_128_GCM_SHA256",
        AlertDesc.HandshakeFailure,
      );
    }

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

    // Address validation via TLS cookie (HRR). Cookie is stateless and embeds
    // CH1 message_hash + optional selected_group so other sources cannot wipe
    // the verified material by sending a second cookie-less CH.
    // Combined cookie+group HRR when both needed (single HRR only).
    if (this.addressValidation === "dtls-cookie" && !this.addressValidated) {
      const cookieExt = ch.extensions.find(
        (e) => e.type === CookieExtension.type,
      );
      if (!cookieExt) {
        // Unauthenticated CH: reply HRR to *this* source only. Store attempt
        // under peerKey; never clear other peers' attempts.
        const peer =
          this.currentPeerKey && this.currentPeerKey !== "unknown"
            ? this.currentPeerKey
            : this.associationPeerKey();
        await this.sendHelloRetryRequest(
          needGroupHrr ? hrrGroupCandidate : undefined,
          true,
          body,
          peer,
        );
        return;
      }
      let cookieBuf: Buffer;
      try {
        cookieBuf = CookieExtension.fromData(cookieExt.data).cookie;
      } catch (e) {
        throw new DtlsProtocolError(
          `illegal_parameter: malformed cookie extension (${e instanceof Error ? e.message : String(e)})`,
          AlertDesc.IllegalParameter,
        );
      }
      const bindPeer =
        this.currentPeerKey && this.currentPeerKey !== "unknown"
          ? this.currentPeerKey
          : this.associationPeerKey();
      const verified = verifyAddressCookie(
        this.cookieSecret,
        cookieBuf,
        bindPeer,
      );
      if (!verified) {
        // RFC 9147 §5.1: invalid cookie → illegal_parameter (this attempt only)
        throw new DtlsProtocolError(
          "illegal_parameter: invalid DTLS cookie (peer address or ClientHello binding mismatch)",
          AlertDesc.IllegalParameter,
        );
      }
      // Restore CH1 for optional field checks from per-peer map when present
      const attempt = this.getPreCookieAttempt(bindPeer);
      if (attempt?.ch1MessageHash.equals(verified.ch1MessageHash)) {
        this.firstClientHelloBody = attempt.ch1Body;
      } else {
        // Stateless path: no CH1 body — transcript uses precomputed message_hash
        this.firstClientHelloBody = undefined;
      }
      this.cookieClientHelloHash = verified.ch1MessageHash;
      this.hrrHadCookie = true;
      this.hrrSelectedGroup = verified.selectedGroup;
      this.hrrCount = 1;
      this.awaitingHrr = true;
      this.tlsCookie = Buffer.from(cookieBuf);
      // Rebuild transcript: message_hash(CH1) + reconstructed HRR
      this.transcript = new HandshakeTranscript();
      this.transcript.replaceWithPrecomputedMessageHash(
        verified.ch1MessageHash,
      );
      const hrrBody = this.buildHelloRetryRequestBody(
        verified.selectedGroup,
        cookieBuf,
      );
      this.transcript.add(HandshakeType.server_hello_2, hrrBody);
      this.messageSeq = 0; // last server HS was HRR seq 0

      // CH2 ≒ CH1 (RFC 8446 §4.1.4): full body compare when map hit; otherwise
      // verify immutable-fields digest embedded in the stateless cookie.
      if (this.firstClientHelloBody) {
        this.validateClientHelloAfterHrr(this.firstClientHelloBody, ch, body);
      } else {
        const imm2 = clientHelloImmutableFieldsHash(body, {
          hrrSelectedGroup: verified.selectedGroup,
        });
        if (!imm2.equals(verified.ch1ImmutableHash)) {
          throw new DtlsProtocolError(
            "illegal_parameter: ClientHello2 immutable fields do not match cookie-bound ClientHello1",
            AlertDesc.IllegalParameter,
          );
        }
        // key_share shape when HRR selected_group was present
        if (verified.selectedGroup !== undefined) {
          const shares = ks.clientShares ?? [];
          if (
            shares.length !== 1 ||
            shares[0].group !== verified.selectedGroup
          ) {
            throw new DtlsProtocolError(
              `illegal_parameter: ClientHello2 key_share must be a single entry for HRR selected_group 0x${verified.selectedGroup.toString(16)}`,
              AlertDesc.IllegalParameter,
            );
          }
        }
        // early_data must not appear after HRR
        if (ch.extensions.some((e) => e.type === EXT_EARLY_DATA)) {
          throw new DtlsProtocolError(
            "illegal_parameter: ClientHello2 must not contain early_data after HRR",
            AlertDesc.IllegalParameter,
          );
        }
      }

      this.addressValidated = true;
      // Cookie validates return-routability — lock + pin this association
      this.acceptAssociationPeer();
      this.pinPeer(
        this.associationPeerKey(),
        this.currentPeerAddr ?? this.getSendAddr(),
      );
      this.clearPreCookieAttempts();
      // Group HRR already satisfied by CH2 if selected_group was in cookie
      if (needGroupHrr && verified.selectedGroup === undefined) {
        throw new DtlsProtocolError(
          "illegal_parameter: cookie did not carry selected_group required for key_share",
          AlertDesc.IllegalParameter,
        );
      }
    } else {
      // ice-authenticated / none: first fully validated CH locks association
      this.acceptAssociationPeer();
      // After HRR without cookie path (group-only HRR on trusted address)
      if (this.awaitingHrr && this.firstClientHelloBody) {
        this.validateClientHelloAfterHrr(this.firstClientHelloBody, ch, body);
      }
    }

    if (needGroupHrr && this.addressValidated) {
      // Trusted address (none/ice) or post-cookie still needs group HRR only
      // (dtls-cookie with group already combined into cookie HRR above).
      if (this.addressValidation === "dtls-cookie") {
        // Cookie path should have combined group into the cookie HRR
        // If we still need group after cookie, CH2 was wrong
        throw new DtlsProtocolError(
          "illegal_parameter: ClientHello2 still has no acceptable key_share after cookie HRR",
          AlertDesc.IllegalParameter,
        );
      }
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

    if (!clientShare) {
      throw new DtlsProtocolError(
        "handshake_failure: ClientHello has no acceptable key_share",
        AlertDesc.HandshakeFailure,
      );
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
    if (this.awaitingHrr) {
      // second CH after HRR — transcript already has message_hash + HRR
      // (cookie path rebuilds it even without firstClientHelloBody)
      this.transcript.add(HandshakeType.client_hello_1, body);
      this.awaitingHrr = false;
    } else {
      this.transcript = new HandshakeTranscript();
      this.transcript.add(HandshakeType.client_hello_1, body);
    }

    await this.sendServerFlight();
  }

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

    // ECDHE — cryptographically invalid share → illegal_parameter (not timeout)
    let shared: Buffer;
    try {
      shared = prfPreMasterSecret(
        this.remoteKeyShare!.keyExchange,
        this.localKeyPair.privateKey,
        this.selectedGroup,
      );
    } catch (e) {
      throw new DtlsProtocolError(
        `illegal_parameter: invalid peer key_share / ECDH (${e instanceof Error ? e.message : String(e)})`,
        AlertDesc.IllegalParameter,
      );
    }
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
    this.hsPhase = this.expectClientCertificate
      ? "wait_client_cert"
      : "wait_client_finished";
  }
}
