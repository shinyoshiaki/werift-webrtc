import {
  CipherSuite,
  type NamedCurveAlgorithms,
} from "../../../../cipher/const";
import { prfPreMasterSecret } from "../../../../cipher/prf";
import { schemesForKey } from "../../../../cipher/tls13/signature";
import { HandshakeType } from "../../../../handshake/const";
import { CookieExtension } from "../../../../handshake/extensions/cookie";
import { KeyShare } from "../../../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../../../handshake/extensions/useSrtp";
import { ServerHello } from "../../../../handshake/message/server/hello";
import { CertificateRequest13 } from "../../../../handshake/message/tls13/certificateRequest";
import { EncryptedExtensions } from "../../../../handshake/message/tls13/encryptedExtensions";
import { DtlsRandom } from "../../../../handshake/random";
import type { SrtpProfile } from "../../../../imports/rtp";
import { AlertDesc } from "../../../../record/const";
import { createEpochProtection } from "../../../../record/v1_3/record";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsProtocolError,
  ProtocolVersionError,
} from "../../../../version";
import type { Dtls13Host } from "../../host";
import { HandshakeTranscript } from "../../transcript";
import { HRR_RANDOM } from "../../types";
import {
  EE_KNOWN_ALLOWED_EXTS,
  HRR_ALLOWED_EXTS,
  KNOWN_EXTENSION_TYPES,
  SERVER_HELLO_ALLOWED_EXTS,
  assertUniqueExtensions,
} from "../extensions";

/**
 * Flight 4 receive (client): ServerHello / HRR, EncryptedExtensions, CertificateRequest.
 * HRR loops back to Flight 1/3 via {@link sendClientHello}.
 */
export async function onServerHello(
  this: Dtls13Host,
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
  const isHrr = DtlsRandom.bytes32(sh.random).equals(HRR_RANDOM);

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
  const selected = SupportedVersions.fromData(versionsExt.data, true).selected!;
  if (selected !== DTLS_1_3_VERSION) {
    throw new ProtocolVersionError(
      `server selected unsupported version 0x${selected.toString(16)}`,
    );
  }

  // Client destination is already pinned at connect(); only count anti-amp RX.
  // Do not rebind TX to a different source (acceptAssociationPeer no-ops on pin mismatch).
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
    // Stay in wait_server_hello for the final ServerHello after CH2
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

  let shared: Buffer;
  try {
    shared = prfPreMasterSecret(
      serverShare.keyExchange,
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

  const ep2 = createEpochProtection(2);
  ep2.writeKeys = this.keySchedule.trafficKeys(this.clientHsTraffic);
  ep2.readKeys = this.keySchedule.trafficKeys(this.serverHsTraffic);
  this.installEpoch(2, ep2);
  this.readEpoch = 2;
  this.writeEpoch = 2;
  this.clientExpectsServerFlight = true;
  this.hsPhase = "wait_ee";
}

export async function onEncryptedExtensions(
  this: Dtls13Host,
  body: Buffer,
): Promise<void> {
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
    // RFC 5764: server may echo the client's MKI or return empty (disable MKI).
    // A different non-empty MKI is illegal.
    const respMki = Buffer.from(use.mki ?? Buffer.alloc(0));
    if (respMki.length > 0 && !respMki.equals(this.clientOfferedSrtpMki)) {
      throw new DtlsProtocolError(
        "illegal_parameter: use_srtp MKI in server response does not match ClientHello offer",
        AlertDesc.IllegalParameter,
      );
    }
    this.negotiatedSrtpProfile = selected;
  }
  this.transcript.add(HandshakeType.encrypted_extensions_8, body);
}

export async function onCertificateRequest(
  this: Dtls13Host,
  body: Buffer,
): Promise<void> {
  const cr = CertificateRequest13.deSerialize(body);
  assertUniqueExtensions(cr.extensions, "CertificateRequest");
  // Main handshake: context MUST be zero-length (post-handshake auth not supported)
  if (cr.certificateRequestContext.length !== 0) {
    throw new DtlsProtocolError(
      "illegal_parameter: CertificateRequest.certificate_request_context must be empty in main handshake",
      AlertDesc.IllegalParameter,
    );
  }
  // certificate_request_context must be echoed in client Certificate (RFC 8446 §4.3.2)
  this.certificateRequestContext = Buffer.from(cr.certificateRequestContext);
  this.peerRequestedClientCert = true;
  // signature_algorithms is MUST in CertificateRequest (RFC 8446 §4.3.2)
  const sigExt = cr.extensions.find((e) => e.type === SignatureAlgorithms.type);
  if (!sigExt) {
    throw new DtlsProtocolError(
      "missing_extension: CertificateRequest requires signature_algorithms",
      AlertDesc.MissingExtension,
    );
  }
  let schemes: number[];
  try {
    schemes = SignatureAlgorithms.fromData(sigExt.data).schemes;
  } catch {
    throw new DtlsProtocolError(
      "decode_error: CertificateRequest invalid signature_algorithms",
      AlertDesc.DecodeError,
    );
  }
  if (!schemes.length) {
    throw new DtlsProtocolError(
      "missing_extension: CertificateRequest signature_algorithms empty",
      AlertDesc.MissingExtension,
    );
  }
  // Peer preference order for any CertificateVerify we may send
  this.certificateRequestSignatureSchemes = schemes;
  this.peerSignatureSchemes = schemes;
  // RFC 8446: if we cannot produce a matching CertificateVerify scheme for
  // our actual key, send empty Certificate (decline) — do not abort.
  if (this.hasLocalIdentity && this.keyPem) {
    const keySchemes = schemesForKey(this.keyPem);
    this.presentClientCertificate = schemes.some((s) => keySchemes.includes(s));
  } else {
    this.presentClientCertificate = false;
  }
  this.transcript.add(HandshakeType.certificate_request_13, body);
}
