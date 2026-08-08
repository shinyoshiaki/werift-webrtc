import { randomBytes } from "crypto";
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
  DTLS_1_3_VERSION,
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
      exts.push(
        UseSRTP.create(this.options.srtpProfiles, Buffer.from([0x00]))
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
    if (group !== undefined) {
      extensions.push(KeyShare.forHelloRetryRequest(group).serverExtension);
    }
    if (withCookie) {
      const binding = cookieBinding(this.peerKey, clientHelloBody);
      const cookie = mintCookie(this.cookieSecret, binding);
      this.tlsCookie = Buffer.from(cookie);
      this.cookieClientHelloHash = hashSha256(clientHelloBody);
      extensions.push(new CookieExtension(cookie).extension);
    }
    const hrr = new ServerHello(
      WireVersion.DTLS_1_2,
      hrrRandom,
      this.sessionId,
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

    // signature_algorithms is mandatory for certificate authentication (RFC 8446 §4.2.3)
    const sigExt = ch.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    if (!sigExt) {
      await this.sendFatalAlert(AlertDesc.MissingExtension);
      this.fail(
        new Error("missing signature_algorithms extension in ClientHello"),
      );
      return;
    }
    try {
      const schemes = SignatureAlgorithms.fromData(sigExt.data).schemes;
      if (!schemes.length) {
        await this.sendFatalAlert(AlertDesc.MissingExtension);
        this.fail(new Error("ClientHello signature_algorithms empty"));
        return;
      }
      this.peerSignatureSchemes = schemes;
    } catch {
      await this.sendFatalAlert(AlertDesc.DecodeError);
      this.fail(new Error("ClientHello signature_algorithms invalid"));
      return;
    }

    // supported_groups ∩ local groups (RFC 8446) — required for HRR selection
    const sgExt = ch.extensions.find((e) => e.type === EllipticCurves.type);
    let clientSupportedGroups: number[] = [];
    if (sgExt) {
      try {
        clientSupportedGroups = EllipticCurves.fromData(sgExt.data).data;
      } catch {
        clientSupportedGroups = [];
      }
    }
    const groupIntersection = this.groups.filter((g) =>
      clientSupportedGroups.includes(g),
    );
    if (groupIntersection.length === 0) {
      // Protocol failure (not forged noise): alert + tear down (do not silent-drop)
      await this.sendFatalAlert(AlertDesc.HandshakeFailure);
      this.fail(
        new Error(
          "no overlapping named groups (supported_groups ∩ server groups empty)",
        ),
      );
      return;
    }

    // Key share: needed both for combined cookie HRR and for accepting CH
    const keyShareExt = ch.extensions.find((e) => e.type === KeyShare.type);
    if (!keyShareExt) {
      throw new Error("ClientHello missing key_share");
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
      throw new Error(
        "client key_share has no acceptable group and no HRR candidate in intersection",
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
        this.sessionId = Buffer.from(ch.sessionId);
        if (this.hrrCount >= 1) {
          throw new Error("second HelloRetryRequest not allowed");
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
      const binding = cookieBinding(this.peerKey, chForBind);
      if (!verifyCookie(this.cookieSecret, cookie, binding)) {
        throw new Error(
          "invalid DTLS cookie (peer address or ClientHello binding mismatch)",
        );
      }
      this.addressValidated = true;
      this.tlsCookie = Buffer.from(cookie);
    }

    if (needGroupHrr) {
      this.firstClientHelloBody = this.firstClientHelloBody ?? body;
      this.sessionId = Buffer.from(ch.sessionId);
      if (this.hrrCount >= 1) {
        throw new Error("second HelloRetryRequest not allowed");
      }
      this.hrrCount += 1;
      await this.sendHelloRetryRequest(hrrGroupCandidate, false, body);
      return;
    }

    this.remoteKeyShare = clientShare;
    this.selectedGroup = clientShare.group as NamedCurveAlgorithms;
    this.localKeyPair = generateKeyPair(this.selectedGroup);
    this.clientRandom = DtlsRandom.from(ch.random as any);
    this.sessionId = Buffer.from(ch.sessionId);
    // Server message_seq: first ServerHello is 0; after HRR (already 0) continue at 1
    if (!this.awaitingHrr) {
      this.messageSeq = -1; // sendServerFlight does +=1 → ServerHello seq 0
    }
    // if post-HRR, messageSeq remains 0 from HRR; sendServerFlight +=1 → SH seq 1

    // use_srtp
    const srtpExt = ch.extensions.find((e) => e.type === UseSRTP.type);
    if (srtpExt && this.options.srtpProfiles?.length) {
      try {
        const use = UseSRTP.fromData(srtpExt.data);
        const match = use.profiles.find((p) =>
          this.options.srtpProfiles!.includes(p as SrtpProfile),
        );
        if (match) this.negotiatedSrtpProfile = match;
      } catch {
        /* ignore */
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

    const sh = new ServerHello(
      WireVersion.DTLS_1_2,
      this.serverRandom,
      this.sessionId,
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
      eeExts.push(
        UseSRTP.create(
          [this.negotiatedSrtpProfile as SrtpProfile],
          Buffer.from([0x00]),
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
      this.certificateRequestContext = Buffer.from(randomBytes(8));
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
    const serverCvScheme = selectSignatureScheme(
      this.keyPem,
      this.peerSignatureSchemes,
    );
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
    await this.carrier.send(this.pendingServerHello);

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

    if (isHrr) {
      // RFC 8446 §4.1.4: at most one HRR; selected_group must be newly offered
      if (this.hrrCount >= 1) {
        throw new Error("second HelloRetryRequest not allowed");
      }
      this.hrrCount += 1;
      const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
      const group = ksExt
        ? KeyShare.fromServerData(ksExt.data).selectedGroup
        : undefined;
      if (group !== undefined) {
        if (!this.groups.includes(group as NamedCurveAlgorithms)) {
          throw new Error(
            `HRR selected_group 0x${group.toString(16)} not in client supported_groups`,
          );
        }
        if (this.initialKeyShareGroups.includes(group)) {
          throw new Error(
            `HRR selected_group 0x${group.toString(16)} was already in initial key_share`,
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
      throw new Error(
        `unsupported cipher suite 0x${sh.cipherSuite.toString(16)}`,
      );
    }

    const ksExt = sh.extensions.find((e) => e.type === KeyShare.type);
    if (!ksExt) throw new Error("ServerHello missing key_share");
    const serverShare = KeyShare.fromServerData(ksExt.data).serverShare!;
    // RFC 8446: server_share.group must match the KeyShareEntry the client sent
    // in the (post-HRR) ClientHello — tracked as this.selectedGroup.
    if (serverShare.group !== this.selectedGroup) {
      throw new Error(
        `ServerHello key_share group 0x${serverShare.group.toString(16)} does not match offered 0x${this.selectedGroup.toString(16)}`,
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
    // Negotiate use_srtp from EncryptedExtensions (TLS 1.3 placement)
    const srtpExt = ee.extensions.find((e) => e.type === UseSRTP.type);
    if (srtpExt && this.options.srtpProfiles?.length) {
      try {
        const use = UseSRTP.fromData(srtpExt.data);
        const match = use.profiles.find((p) =>
          this.options.srtpProfiles!.includes(p as SrtpProfile),
        );
        if (match !== undefined) this.negotiatedSrtpProfile = match;
      } catch {
        /* ignore malformed */
      }
    }
    this.transcript.add(HandshakeType.encrypted_extensions_8, body);
  }

  protected async onCertificateRequest(body: Buffer): Promise<void> {
    const cr = CertificateRequest13.deSerialize(body);
    // certificate_request_context must be echoed in client Certificate (RFC 8446 §4.3.2)
    this.certificateRequestContext = Buffer.from(cr.certificateRequestContext);
    this.peerRequestedClientCert = true;
    // signature_algorithms in CertificateRequest constrains CertificateVerify
    const sigExt = cr.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    if (sigExt) {
      try {
        const schemes = SignatureAlgorithms.fromData(sigExt.data).schemes;
        if (!schemes.length) {
          throw new Error("CertificateRequest signature_algorithms empty");
        }
        // Keep peer order for CertificateVerify selection; require intersection
        const ok = schemes.some((s) =>
          this.localOfferedSignatureSchemes.includes(s),
        );
        if (!ok) {
          throw new Error(
            "no overlapping signature_algorithms with CertificateRequest",
          );
        }
        this.certificateRequestSignatureSchemes = schemes;
        this.peerSignatureSchemes = schemes;
      } catch (e) {
        if (e instanceof Error && /overlapping|empty/.test(e.message)) throw e;
        throw new Error("CertificateRequest invalid signature_algorithms");
      }
    }
    this.transcript.add(HandshakeType.certificate_request_13, body);
  }

  protected async onCertificate(body: Buffer): Promise<void> {
    const cert = Certificate13.deSerialize(body);
    // Empty certificate list is allowed for optional client auth decline;
    // we require a cert when we requested one.
    if (this.role === "server" && this.expectClientCertificate) {
      if (!cert.certificates.length) {
        throw new Error("client Certificate required but empty list received");
      }
      // RFC 8446: client Certificate.context MUST equal CertificateRequest.context
      if (
        !cert.certificateRequestContext.equals(this.certificateRequestContext)
      ) {
        throw new Error("client certificate_request_context mismatch");
      }
      this.remoteCert = cert.certificates[0];
      this.clientCertificateReceived = true;
      this.transcript.add(HandshakeType.certificate_11, body);
      return;
    }
    if (!cert.certificates.length) {
      throw new Error("empty certificate list");
    }
    // Server Certificate uses empty context
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
      const clientMsgs: FragmentedHandshake[] = [];
      if (this.peerRequestedClientCert) {
        if (!this.hasLocalIdentity || !this.certDer.length || !this.keyPem) {
          throw new Error(
            "server requested client certificate but client cert/key not configured",
          );
        }
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
      // Server receives client Finished — require mutual auth if requested
      if (this.expectClientCertificate) {
        if (
          !this.clientCertificateReceived ||
          !this.clientCertificateVerified
        ) {
          throw new Error(
            "client Finished before Certificate/CertificateVerify (mutual auth)",
          );
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
    // ACK KeyUpdate so peer can stop retransmission (RFC 9147 post-HS)
    void this.sendAck().catch((e) => this.fail(e));
    if (ku.requestUpdate) {
      this.keyUpdate(false).catch((e) => this.fail(e));
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
