import {
  CipherSuite,
  NamedCurveAlgorithm,
  type NamedCurveAlgorithms,
} from "./cipher/const";
import { generateKeyPair } from "./cipher/namedCurve";
import { SessionType } from "./cipher/suites/abstract";
import {
  Dtls13Connection,
  type DualResumeClientHello,
} from "./engine/v1_3/connection";
import { Flight1 } from "./flight/client/flight1";
import { Flight3 } from "./flight/client/flight3";
import { Flight5 } from "./flight/client/flight5";
import { HandshakeType } from "./handshake/const";
import { CookieExtension } from "./handshake/extensions/cookie";
import { EllipticCurves } from "./handshake/extensions/ellipticCurves";
import { KeyShare } from "./handshake/extensions/keyShare";
import {
  DEFAULT_SIGNATURE_SCHEMES,
  SignatureAlgorithms,
} from "./handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "./handshake/extensions/supportedVersions";
import { ClientHello } from "./handshake/message/client/hello";
import { ServerHello } from "./handshake/message/server/hello";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { DtlsRandom } from "./handshake/random";
import { debug } from "./imports/common";
import { ContentType } from "./record/const";
import type { FragmentedHandshake } from "./record/message/fragment";
import { serializePlaintextRecord } from "./record/v1_3/record";
import { type DtlsInternalOptions, DtlsSocket, type Options } from "./socket";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsVersion,
  DtlsVersionSelected,
  ProtocolVersionError,
  hasTlsDowngradeSentinel,
  protocolVersionsToWire,
  supportsVersion,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/client.ts : log");

export class DtlsClient extends DtlsSocket {
  /**
   * Dual association active: ClientHello still advertises all configured
   * versions in `supported_versions` preference order. Final version is
   * confirmed by ServerHello (1.3 resume or 1.2 + DOWNGRD check), never by
   * unauthenticated HelloVerifyRequest alone.
   */
  private dualCookiePath = false;

  /**
   * Last dual-negotiation ClientHello + ECDHE key material so a later
   * DTLS 1.3 ServerHello/HRR can prime a fresh 1.3 engine without re-sending CH.
   */
  private dualResume?: DualResumeClientHello;

  /** Public constructor — accepts stable {@link Options} only. */
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    const dual =
      supportsVersion(versions, DtlsVersion.V1_3) &&
      supportsVersion(versions, DtlsVersion.V1_2);
    // protocolVersions[0] is highest local preference (shared selectVersion semantics).
    const prefer13 = versions[0] === DtlsVersion.V1_3;

    // Pure 1.3, or dual with 1.3 preferred: start 1.3 engine; CH advertises full list.
    // Dual with 1.2 preferred: stay on association dual-CH path (no pure-1.3 engine first).
    if (only13 || (dual && prefer13)) {
      this.startEngine13(only13, versions);
    } else if (dual && !prefer13) {
      // [V1_2, V1_3]: dual CH on 1.2 carrier; ServerHello decides 1.2 vs 1.3 resume.
      this.dualCookiePath = true;
      this.setupExtensionsForDualCookiePath();
    }

    log(this.dtls.sessionId, "start client", {
      versions,
      only13,
      dual,
      prefer13,
    });
  }

  private startEngine13(strict13: boolean, offered: readonly DtlsVersion[]) {
    const engine = new Dtls13Connection(
      {
        transport: this.options.transport,
        cert: this.options.cert,
        key: this.options.key,
        srtpProfiles: this.options.srtpProfiles,
        certificateRequest: this.options.certificateRequest,
        addressValidation: this.options.addressValidation,
        groups: this.options.namedGroups
          ? [...this.options.namedGroups]
          : undefined,
        mtu: this.options.mtu,
        // handshakeCarrier is DtlsInternalOptions only (not stable Public API)
        carrier: (this.options as DtlsInternalOptions).handshakeCarrier,
        offeredProtocolVersions: offered,
      },
      SessionType.CLIENT,
    );

    const dualCanContinue12 =
      !strict13 && supportsVersion(this.protocolVersions, DtlsVersion.V1_2);

    this.bridgeEngine13(engine, {
      filterError: (e) =>
        dualCanContinue12 &&
        !this.dualCookiePath &&
        e instanceof DtlsVersionSelected &&
        e.version === DtlsVersion.V1_2,
    });

    if (dualCanContinue12) {
      engine.onError.subscribe((e) => {
        if (this.dualCookiePath) return;
        if (
          !(e instanceof DtlsVersionSelected) ||
          e.version !== DtlsVersion.V1_2
        ) {
          return;
        }
        log(
          "dual association: HVR → dual negotiation path (still offer 1.3 until ServerHello)",
          e.message,
        );
        this.dualCookiePath = true;
        this.engine13 = undefined;
        this.connected = false;
        // Capture CH1 before release so we re-send the same random + cookie
        // (flight2 already bound remoteRandom to that CH).
        this.dualResume = engine.exportDualResumeClientHello();
        engine.releaseForVersionFallback();
        this.transport.socket.onData = this.udpOnMessage;
        this.dtls = new (this.dtls.constructor as any)(
          this.options,
          this.sessionType,
        );
        this.cipher = new (this.cipher.constructor as any)(
          this.sessionType,
          this.options.cert,
          this.options.key,
          this.options.signatureHash,
        );
        this.srtp = new (this.srtp.constructor as any)();
        // Dual extensions: keep advertising full supported_versions preference order
        this.setupExtensionsForDualCookiePath();
        void this.continueDualAfterHvr(e.helloVerifyCookie).catch((err) =>
          this.onError.execute(
            err instanceof Error ? err : new Error(String(err)),
          ),
        );
      });
    }
  }

  /**
   * Dual negotiation extensions: advertise all configured versions in
   * preference order and keep key_share / 0x1301 so a 1.3-capable server can
   * still select 1.3 after an unauthenticated HVR. 1.2-only peers ignore 1.3
   * extensions. HVR never finalizes the version.
   */
  private setupExtensionsForDualCookiePath() {
    this.extensions = [];
    this.setupExtensions();
    // supported_versions in local preference order (protocolVersions)
    const sv = SupportedVersions.forClient(
      protocolVersionsToWire(this.protocolVersions),
    );
    this.extensions.unshift(sv.clientExtension);
  }

  /**
   * After HVR: continue dual negotiation with the **same** ClientHello (same
   * random) plus DTLS 1.2 legacy cookie. Never treat HVR as final version pick.
   */
  private async continueDualAfterHvr(cookie?: Buffer) {
    if (this.dualResume) {
      await this.resendDualClientHelloWithCookie(cookie);
      return;
    }
    await this.sendDualNegotiationClientHello(cookie);
  }

  /**
   * Resend the dual CH already exported from the 1.3 engine (or prior dual CH),
   * only adding/replacing the legacy cookie for the DTLS 1.2 cookie path.
   *
   * **Important:** dualResume keeps the original CH-A body (no legacy cookie).
   * A legitimate dual 1.3 server may still answer CH-A (HRR/SH) after a
   * spoofed/stale HVR; 1.3 resume must prime with the CH the server saw.
   * Random + ECDHE keyPair are unchanged so flight2 / key_share stay aligned.
   */
  private async resendDualClientHelloWithCookie(legacyCookie?: Buffer) {
    if (!this.dualResume) {
      throw new Error("dual resume ClientHello missing for HVR cookie path");
    }
    // Build cookie CH from original dualResume without mutating 1.3 resume material.
    const hello = ClientHello.deSerialize(this.dualResume.clientHelloBody);
    hello.cookie = legacyCookie
      ? Buffer.from(legacyCookie)
      : Buffer.from([]);
    // Clear messageSeq so Flight1 re-assigns seq 0 for this transmission
    hello.messageSeq = undefined as any;

    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
      hello,
    );
  }

  /**
   * Build & send dual CH: versions in preference order, 1.3 suites/extensions
   * + 1.2 suites for true dual peers. Stores ECDHE material for possible 1.3
   * resume when ServerHello selects 1.3.
   */
  private async sendDualNegotiationClientHello(legacyCookie?: Buffer) {
    const named =
      this.options.namedGroups?.length && this.options.namedGroups.length > 0
        ? ([...this.options.namedGroups] as NamedCurveAlgorithms[])
        : ([
            NamedCurveAlgorithm.x25519_29,
            NamedCurveAlgorithm.secp256r1_23,
          ] as NamedCurveAlgorithms[]);
    const group = named[0];
    const keyPair = generateKeyPair(group);
    const curves = EllipticCurves.createEmpty();
    curves.data = named as any;

    // 1.3 CertificateVerify schemes + rsa_pkcs1 for DTLS 1.2 peers
    const schemes = [...DEFAULT_SIGNATURE_SCHEMES];
    if (!schemes.includes(0x0401)) schemes.push(0x0401);

    // Preference order from Options.protocolVersions (not hard-coded 1.3-first)
    const wireVersions = protocolVersionsToWire(this.protocolVersions);

    const extensions = [
      SupportedVersions.forClient(wireVersions).clientExtension,
      curves.extension,
      KeyShare.forClient([{ group, keyExchange: keyPair.publicKey }])
        .clientExtension,
      SignatureAlgorithms.create(schemes).extension,
      ...this.extensions.filter(
        (e) =>
          e.type !== SupportedVersions.type &&
          e.type !== EllipticCurves.type &&
          e.type !== SignatureAlgorithms.type &&
          e.type !== KeyShare.type &&
          e.type !== CookieExtension.type,
      ),
    ];

    // Suite list: when preferring 1.2, list 1.2 suites first (cosmetic / legacy peers)
    const prefer13 = this.protocolVersions[0] === DtlsVersion.V1_3;
    const suite13 = CipherSuite.TLS_AES_128_GCM_SHA256_0x1301;
    const suites12 = [
      CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195,
      CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199,
    ];
    const cipherSuites = prefer13
      ? [suite13, ...suites12]
      : [...suites12, suite13];

    const hello = new ClientHello(
      { major: 255 - 1, minor: 255 - 2 },
      new DtlsRandom(),
      Buffer.from([]),
      legacyCookie ? Buffer.from(legacyCookie) : Buffer.from([]),
      cipherSuites,
      [0],
      extensions,
    );

    const body = hello.serialize();
    this.dualResume = {
      clientHelloBody: Buffer.from(body),
      keyPair: {
        publicKey: Buffer.from(keyPair.publicKey),
        privateKey: Buffer.from(keyPair.privateKey),
        curve: group,
      },
      group,
    };

    // Flight retransmit until HVR (flight 3) or we stop on 1.3 resume
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
      hello,
    );
  }

  /**
   * True when a DTLSPlaintext datagram contains ServerHello/HRR that selects
   * DTLS 1.3 via supported_versions (extension type 43).
   */
  private datagramSelectsDtls13(data: Buffer): boolean {
    try {
      let off = 0;
      while (off + 13 <= data.length) {
        const contentType = data[off];
        const contentLen = data.readUInt16BE(off + 11);
        if (contentLen < 0 || off + 13 + contentLen > data.length) break;
        const body = data.subarray(off + 13, off + 13 + contentLen);
        if (contentType === ContentType.handshake && body.length >= 12) {
          const msgType = body[0];
          if (msgType === HandshakeType.server_hello_2) {
            // DTLS HS fragment: type(1) length(3) message_seq(2)
            // fragment_offset(3) fragment_length(3) + body
            const fragLen = (body[9] << 16) | (body[10] << 8) | body[11];
            const hsBody = body.subarray(
              12,
              12 + Math.min(fragLen, body.length - 12),
            );
            if (hsBody.length >= 2) {
              try {
                const sh = ServerHello.deSerialize(hsBody);
                const versionsExt = sh.extensions.find(
                  (e) => e.type === SupportedVersions.type,
                );
                if (versionsExt) {
                  const sv = SupportedVersions.fromData(versionsExt.data, true);
                  if (sv.selected === DTLS_1_3_VERSION) return true;
                }
              } catch {
                // not a complete ServerHello — keep scanning
              }
            }
          }
        }
        off += 13 + contentLen;
        if (contentLen === 0) break;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Dual path: ServerHello selected DTLS 1.3 — prime a new 1.3 engine from the
   * dual CH already sent and reinject the full datagram (SH/HRR + any coalesced
   * records).
   */
  private resumeDtls13FromDualPath(datagram: Buffer): void {
    if (!this.dualResume) {
      this.onError.execute(
        new ProtocolVersionError(
          "dual path selected DTLS 1.3 but dual ClientHello material is missing",
        ),
      );
      return;
    }
    // Stop 1.2 Flight1 retransmit by advancing flight only — never set fatalError
    // for a successful version commit (would surface as delayed public onError).
    this.dtls.flight = 99;

    log("dual association: ServerHello selected DTLS 1.3 — resume 1.3 engine");
    const engine = new Dtls13Connection(
      {
        transport: this.options.transport,
        cert: this.options.cert,
        key: this.options.key,
        srtpProfiles: this.options.srtpProfiles,
        certificateRequest: this.options.certificateRequest,
        addressValidation: this.options.addressValidation,
        groups: this.options.namedGroups
          ? [...this.options.namedGroups]
          : undefined,
        mtu: this.options.mtu,
        // Same injected carrier instance as Epic 2; soft HVR detach must not
        // have permanently closed it (releaseForVersionFallback).
        carrier: (this.options as DtlsInternalOptions).handshakeCarrier,
        offeredProtocolVersions: this.protocolVersions,
      },
      SessionType.CLIENT,
    );
    // Prime with original CH-A (pre-cookie) so transcript/ECDHE match the
    // server response for the first dual ClientHello, not a post-HVR rewrite.
    engine.primeFromSentClientHello(this.dualResume);
    this.bridgeEngine13(engine);
    this.dualCookiePath = false;
    this.dualResume = undefined;
    // Full datagram reinject so coalesced epoch-2 records are not lost
    const rinfo = (
      this.options.transport as {
        rinfo?: { address?: string; port?: number };
      }
    ).rinfo;
    engine.injectDatagram(datagram, rinfo);
  }

  async connect() {
    if (this.engine13) {
      await this.engine13.connect();
      return;
    }
    // Dual [V1_2, V1_3] (or post-HVR dual path): send dual CH, not pure 1.2 Flight1
    if (this.dualCookiePath) {
      await this.sendDualNegotiationClientHello();
      return;
    }
    await this.connect12();
  }

  private async connect12() {
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
    );
  }

  private flight5?: Flight5;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    if (this.engine13) return;

    log(
      this.dtls.sessionId,
      "handleHandshakes",
      assembled.map((a) => a.msg_type),
    );

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        case HandshakeType.hello_verify_request_3:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment,
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
            // Do not overwrite dualResume with the cookie-bearing CH2 body.
            // dualResume is the original dual CH-A used if a 1.3 SH/HRR for
            // that first CH still arrives (spoofed HVR race). Pure 1.2 peers
            // never select 1.3, so cookie CH is only needed on the 1.2 flights.
          }
          break;
        case HandshakeType.server_hello_2:
          {
            if (this.connected) return;
            const only13 =
              this.protocolVersions.length === 1 &&
              this.protocolVersions[0] === DtlsVersion.V1_3;
            if (only13) {
              this.onError.execute(
                new ProtocolVersionError(
                  "DTLS 1.3-only client received non-1.3 ServerHello",
                ),
              );
              return;
            }

            // Dual cookie path: prefer 1.3 if ServerHello selects it (should
            // normally be handled at udpOnMessage reinject; keep as safety net).
            if (this.dualCookiePath) {
              try {
                const sh = ServerHello.deSerialize(handshake.fragment);
                const versionsExt = sh.extensions.find(
                  (e) => e.type === SupportedVersions.type,
                );
                if (versionsExt) {
                  const sv = SupportedVersions.fromData(versionsExt.data, true);
                  if (sv.selected === DTLS_1_3_VERSION) {
                    // Reconstruct a minimal record for reinject (may miss
                    // coalesced records — primary path is udpOnMessage).
                    const fragBytes = handshake.serialize();
                    const pkt = serializePlaintextRecord(
                      ContentType.handshake,
                      0,
                      0,
                      fragBytes,
                    );
                    this.resumeDtls13FromDualPath(pkt);
                    return;
                  }
                }
              } catch (e) {
                if (
                  e instanceof ProtocolVersionError ||
                  (e instanceof Error && e.name === "ProtocolVersionError")
                ) {
                  this.onError.execute(e as Error);
                  return;
                }
              }
            }

            // Dual cookie path: 1.2 ServerHello while we still offered 1.3 —
            // enforce RFC 8446 / 9147 downgrade sentinel check.
            if (
              this.dualCookiePath ||
              supportsVersion(this.protocolVersions, DtlsVersion.V1_3)
            ) {
              try {
                const sh = ServerHello.deSerialize(handshake.fragment);
                const random32 = Buffer.concat([
                  (() => {
                    const b = Buffer.alloc(4);
                    b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
                    return b;
                  })(),
                  sh.random.random_bytes,
                ]);
                // negotiated version is DTLS 1.2 wire (legacy)
                if (hasTlsDowngradeSentinel(random32)) {
                  this.onError.execute(
                    new ProtocolVersionError(
                      "illegal_parameter: ServerHello Random contains TLS downgrade sentinel while client offered DTLS 1.3",
                    ),
                  );
                  return;
                }
              } catch (e) {
                if (
                  e instanceof ProtocolVersionError ||
                  (e instanceof Error && e.name === "ProtocolVersionError")
                ) {
                  this.onError.execute(e as Error);
                  return;
                }
                // fall through to normal 1.2 handling if parse issues
              }
            }

            this.flight5 = new Flight5(
              this.transport,
              this.dtls,
              this.cipher,
              this.srtp,
            );
            this.flight5.handleHandshake(handshake);
          }
          break;
        case HandshakeType.certificate_11:
        case HandshakeType.server_key_exchange_12:
        case HandshakeType.certificate_request_13:
          {
            await this.waitForReady(() => !!this.flight5);
            this.flight5?.handleHandshake(handshake);
          }
          break;
        case HandshakeType.server_hello_done_14:
          {
            await this.waitForReady(() => !!this.flight5);
            this.flight5?.handleHandshake(handshake);

            const targets = [
              11,
              12,
              this.options.certificateRequest && 13,
            ].filter((n): n is number => typeof n === "number");
            await this.waitForReady(() =>
              this.dtls.checkHandshakesExist(targets),
            );
            await this.flight5?.exec();
          }
          break;
        case HandshakeType.finished_20:
          {
            this.dtls.flight = 7;
            this.connected = true;
            this.onConnect.execute();
            log(this.dtls.sessionId, "dtls connected");
          }
          break;
      }
    }
  };

  /**
   * Override UDP RX: while dualCookiePath is active, detect DTLS 1.3 selection
   * and resume the 1.3 engine before the 1.2 parser consumes the datagram.
   *
   * Also ignore unauthenticated fatal alerts while dualResume is still open:
   * a dual 1.3 server may reject the post-HVR legacy-cookie ClientHello
   * (RFC 9147: legacy_cookie must be empty) without that killing the still-
   * valid CH-A → 1.3 path.
   */
  protected udpOnMessage = (data: Buffer) => {
    if (
      this.dualCookiePath &&
      !this.engine13 &&
      this.datagramSelectsDtls13(data)
    ) {
      this.resumeDtls13FromDualPath(data);
      return;
    }
    if (
      this.dualCookiePath &&
      this.dualResume &&
      !this.engine13 &&
      this.datagramIsUnauthenticatedFatalAlert(data)
    ) {
      log(
        "dual association: ignore unauthenticated alert while dualResume open",
      );
      return;
    }
    this.handleUdpDatagram(data);
  };

  /**
   * Epoch-0 fatal Alert record (e.g. illegal_parameter from a dual 1.3 server
   * that rejected a legacy-cookie ClientHello). Not authenticated.
   */
  private datagramIsUnauthenticatedFatalAlert(data: Buffer): boolean {
    try {
      if (data.length < 15) return false;
      const contentType = data[0];
      if (contentType !== ContentType.alert) return false;
      const contentLen = data.readUInt16BE(11);
      if (contentLen < 2 || 13 + contentLen > data.length) return false;
      const level = data[13];
      // TLS alert: level 2 = fatal (also treat unknown high levels as fatal)
      return level >= 2;
    } catch {
      return false;
    }
  }
}
