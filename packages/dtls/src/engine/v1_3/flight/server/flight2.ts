import { CipherSuite } from "../../../../cipher/const";
import { HandshakeType } from "../../../../handshake/const";
import {
  CookieExtension,
  clientHelloMessageHash,
  mintAddressCookie,
} from "../../../../handshake/extensions/cookie";
import { KeyShare } from "../../../../handshake/extensions/keyShare";
import { SupportedVersions } from "../../../../handshake/extensions/supportedVersions";
import { ClientHello } from "../../../../handshake/message/client/hello";
import { ServerHello } from "../../../../handshake/message/server/hello";
import { DtlsRandom } from "../../../../handshake/random";
import { AlertDesc } from "../../../../record/const";
import type { Extension } from "../../../../typings/domain";
import {
  DTLS_1_3_VERSION,
  DtlsProtocolError,
  WireVersion,
} from "../../../../version";
import type { Dtls13Host } from "../../host";
import { HandshakeTranscript } from "../../transcript";
import { HRR_RANDOM } from "../../types";
import { EXT_EARLY_DATA, EXT_PADDING } from "../extensions";

/**
 * Flight 2: HelloRetryRequest (optional cookie / selected_group).
 * Server-only send path; also validates ClientHello2 against CH1 after HRR.
 */
/**
 * Build HelloRetryRequest body (same shape as sendHelloRetryRequest) so a
 * cookie-bearing CH2 can rebuild transcript without stored HRR bytes.
 */
export function buildHelloRetryRequestBody(
  this: Dtls13Host,
  group: number | undefined,
  cookie: Buffer | undefined,
): Buffer {
  const hrrRandom = DtlsRandom.deSerialize(HRR_RANDOM);
  const extensions: Extension[] = [
    SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
  ];
  if (group !== undefined) {
    extensions.push(KeyShare.forHelloRetryRequest(group).serverExtension);
  }
  if (cookie && cookie.length > 0) {
    extensions.push(new CookieExtension(cookie).extension);
  }
  const hrr = new ServerHello(
    WireVersion.DTLS_1_2,
    hrrRandom,
    Buffer.alloc(0),
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
    0,
    extensions,
  );
  hrr.messageSeq = 0;
  return hrr.serialize();
}

export async function sendHelloRetryRequest(
  this: Dtls13Host,
  group: number | undefined,
  withCookie: boolean,
  clientHelloBody: Buffer,
  peerKeyForAttempt?: string,
): Promise<void> {
  const peer =
    peerKeyForAttempt && peerKeyForAttempt !== "unknown"
      ? peerKeyForAttempt
      : this.associationPeerKey();

  // Record HRR deltas for ClientHello2 validation (RFC 8446 §4.1.4)
  this.hrrHadCookie = withCookie;
  this.hrrSelectedGroup = group;

  let cookie: Buffer | undefined;
  if (withCookie) {
    cookie = mintAddressCookie(this.cookieSecret, peer, clientHelloBody, {
      selectedGroup: group,
    });
    this.tlsCookie = Buffer.from(cookie);
    this.cookieClientHelloHash = clientHelloMessageHash(clientHelloBody);
    // Per-peer attempt only — never a single global CH1 slot shared by attackers
    this.storePreCookieAttempt(peer, {
      ch1Body: clientHelloBody,
      ch1MessageHash: this.cookieClientHelloHash,
      selectedGroup: group,
    });
  }

  // Pre-cookie HRR: do not commit a global transcript that another source can
  // corrupt. Transcript is rebuilt from the cookie on CH2. For trusted-address
  // group-only HRR, keep the classic transcript path.
  if (!withCookie) {
    if (this.awaitingHrr) {
      this.messageSeq += 1;
      this.transcript.add(HandshakeType.client_hello_1, clientHelloBody);
    } else {
      this.messageSeq = 0;
      this.transcript = new HandshakeTranscript();
      this.transcript.replaceWithMessageHash(clientHelloBody);
    }
    // Re-serialize HRR with correct message_seq for trusted path
    const hrrRandom = DtlsRandom.deSerialize(HRR_RANDOM);
    const extensions: Extension[] = [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
    ];
    if (group !== undefined) {
      extensions.push(KeyShare.forHelloRetryRequest(group).serverExtension);
    }
    const hrr = new ServerHello(
      WireVersion.DTLS_1_2,
      hrrRandom,
      Buffer.alloc(0),
      CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
      0,
      extensions,
    );
    hrr.messageSeq = this.messageSeq;
    const trustedBody = hrr.serialize();
    this.transcript.add(HandshakeType.server_hello_2, trustedBody);
    this.awaitingHrr = true;
    this.firstClientHelloBody = clientHelloBody;
    const frag = hrr.toFragment();
    frag.message_seq = this.messageSeq;
    await this.sendHandshakeFlight([frag], 0, true);
    return;
  }

  // Cookie HRR: message_seq 0; one-shot send to current peer only.
  // Must NOT be retransmittable: RFC 9147 stateless cookie — if HRR is lost,
  // client retransmits CH1 and server mints a fresh cookie HRR against that
  // CH's RX budget. Putting cookie HRR into global pendingFlight would:
  //   - set pendingFlightReplyTo = A
  //   - allow B's later CH to overwrite anti-amp counters
  //   - retransmit HRR to A using B's budget (amplification / source mix-up)
  this.messageSeq = 0;
  const hrr = new ServerHello(
    WireVersion.DTLS_1_2,
    DtlsRandom.deSerialize(HRR_RANDOM),
    Buffer.alloc(0),
    CipherSuite.TLS_AES_128_GCM_SHA256_0x1301,
    0,
    [
      SupportedVersions.forServer(DTLS_1_3_VERSION).serverExtension,
      ...(group !== undefined
        ? [KeyShare.forHelloRetryRequest(group).serverExtension]
        : []),
      new CookieExtension(cookie!).extension,
    ],
  );
  hrr.messageSeq = 0;
  const frag = hrr.toFragment();
  frag.message_seq = 0;
  // Do not set global awaitingHrr / firstClientHelloBody for pre-cookie HRR —
  // state lives in preCookieAttempts + the cookie itself.
  await this.sendHandshakeFlight(
    [frag],
    0,
    false, // non-retransmittable (stateless cookie; no RTO cache)
    this.currentPeerAddr,
  );
}

/**
 * After HRR, ClientHello2 must match ClientHello1 except RFC 8446 §4.1.4
 * allowed deltas driven by the actual HRR contents:
 * - key_share: only if HRR contained selected_group
 * - cookie: only if HRR contained cookie (then CH2 must include it)
 * - early_data: if present in CH1 must be removed; cannot newly appear
 * - padding: may be added/removed/changed freely
 */
export function validateClientHelloAfterHrr(
  this: Dtls13Host,
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
  if (!DtlsRandom.bytes32(ch1.random).equals(DtlsRandom.bytes32(ch2.random))) {
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
