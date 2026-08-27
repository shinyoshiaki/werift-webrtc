import { createHandshakeDatagram } from "../../carrier/direct";
import type { AckRecordNumber } from "../../handshake/message/tls13/ack";
import { DtlsAck } from "../../handshake/message/tls13/ack";
import { AlertDesc, ContentType } from "../../record/const";
import { FragmentedHandshake } from "../../record/message/fragment";
import {
  encryptRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import { computeDtlsRtoMs } from "../../retransmission";
import { ProtocolVersionError } from "../../version";
import type { Dtls13Host } from "./host";
import {
  ACK_ENCRYPTED_OVERHEAD,
  ACK_PLAINTEXT_OVERHEAD,
  ACK_RECORD_NUMBER_BYTES,
  ANTI_AMPLIFICATION_FACTOR,
  MAX_ACK_RECORD_NUMBERS,
  log,
} from "./types";

/**
 * SPED L1 / onFlightCreated datagrams: coalesce a single epoch-0 ServerHello
 * datagram with the first encrypted datagram when the pair still fits `mtu`.
 */
export function spedNotifySources(
  serverHello: Buffer | readonly Buffer[] | undefined,
  datagrams: readonly Buffer[],
  mtu: number,
): Buffer[] {
  const hellos = !serverHello
    ? []
    : Buffer.isBuffer(serverHello)
      ? [Buffer.from(serverHello)]
      : serverHello.map((datagram) => Buffer.from(datagram));
  if (hellos.length === 0) {
    return datagrams.map((datagram) => Buffer.from(datagram));
  }
  const first = datagrams[0];
  if (hellos.length === 1 && first && hellos[0]!.length + first.length <= mtu) {
    return [
      Buffer.concat([hellos[0]!, first]),
      ...datagrams.slice(1).map((datagram) => Buffer.from(datagram)),
    ];
  }
  return [...hellos, ...datagrams.map((datagram) => Buffer.from(datagram))];
}

function packRecordsIntoDatagrams(
  records: readonly Buffer[],
  mtu: number,
): Buffer[] {
  const datagrams: Buffer[] = [];
  let current: Buffer = Buffer.alloc(0);
  for (const record of records) {
    if (current.length + record.length > mtu && current.length > 0) {
      datagrams.push(current);
      current = Buffer.from(record);
    } else {
      current = current.length
        ? Buffer.concat([current, record])
        : Buffer.from(record);
    }
  }
  if (current.length) {
    datagrams.push(current);
  }
  return datagrams;
}

/**
 * Epoch-0 ServerHello datagrams under `mtu`. Uses the original record when it
 * still fits; otherwise re-chunks pendingServerHelloSource.
 */
export function fragmentPendingServerHello(
  host: Dtls13Host,
  mtu: number,
): Buffer[] {
  const current = host.pendingServerHello?.bytes;
  if (current && current.length <= mtu) {
    return [Buffer.from(current)];
  }
  const cached = host.pendingServerHelloNotify;
  if (
    cached &&
    cached.mtu <= mtu &&
    cached.datagrams.every((datagram) => datagram.length <= mtu)
  ) {
    return cached.datagrams.map((datagram) => Buffer.from(datagram));
  }
  const source = host.pendingServerHelloSource;
  if (!source) {
    return current ? [Buffer.from(current)] : [];
  }
  const maxFrag = mtu - 13 - 12;
  if (maxFrag < 1) {
    return current ? [Buffer.from(current)] : [];
  }
  const chunks =
    source.fragment.length > maxFrag ? source.chunk(maxFrag) : [source];
  const records: Buffer[] = [];
  for (const chunk of chunks) {
    const seq = host.recordSeqEpoch0++;
    records.push(
      serializePlaintextRecord(
        ContentType.handshake,
        0,
        seq,
        chunk.serialize(),
      ),
    );
  }
  const datagrams = packRecordsIntoDatagrams(records, mtu);
  host.pendingServerHelloNotify = {
    mtu,
    datagrams: datagrams.map((datagram) => Buffer.from(datagram)),
  };
  return datagrams;
}

/**
 * Flight transmit path: serialize handshake fragments → records → datagrams,
 * retransmit, anti-amplification budget, and ACK emission.
 * Aligns with outbound arrows in index.ts Figure 3.
 */
/**
 * @param retransmittable When false (pre-cookie HRR), send once without
 * scheduling retransmission — unauthenticated sources must not exhaust
 * shared retransmit state and fail() the server.
 * @param dest Optional explicit destination (currentPeerAddr for pre-cookie).
 */
export async function sendHandshakeFlight(
  this: Dtls13Host,

  fragments: FragmentedHandshake[],
  epoch: number,
  retransmittable: boolean,
  dest?: [string, number],
): Promise<void> {
  this.flightId += 1;
  const flightId = this.flightId;
  const mtu = this.carrier.getMtu();
  // Epoch 0: 13-byte DTLSPlaintext header + 12-byte HS fragment header
  // Encrypted: 5-byte unified header + 12-byte HS header + 1-byte inner
  // content type (DTLSInnerPlaintext) + 16-byte GCM tag
  const maxFrag = epoch === 0 ? mtu - 13 - 12 : mtu - 5 - 12 - 1 - 16;
  if (maxFrag < 1) {
    throw new Error(`MTU ${mtu} too small for handshake records`);
  }

  const packets: Buffer[] = [];
  const packetRecords: AckRecordNumber[] = [];
  for (const f of fragments) {
    const chunks = f.fragment.length > maxFrag ? f.chunk(maxFrag) : [f];
    for (const chunk of chunks) {
      const hsBytes = chunk.serialize();
      if (epoch === 0) {
        const seq = this.recordSeqEpoch0++;
        packetRecords.push({ epoch: 0, sequenceNumber: seq });
        packets.push(
          serializePlaintextRecord(ContentType.handshake, 0, seq, hsBytes),
        );
      } else {
        const ep = this.epochs.get(epoch);
        if (!ep?.writeKeys) {
          throw new Error(`no write keys for epoch ${epoch}`);
        }
        const seq = ep.writeSequence;
        packetRecords.push({ epoch, sequenceNumber: seq });
        packets.push(encryptRecord(hsBytes, ContentType.handshake, ep));
      }
    }
  }

  // Coalesce into datagrams under MTU, tracking which records land in each
  const datagrams: Buffer[] = [];
  const datagramRecordGroups: AckRecordNumber[][] = [];
  let current: Buffer = Buffer.alloc(0);
  let currentRecs: AckRecordNumber[] = [];
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const rn = packetRecords[i];
    if (current.length + p.length > mtu && current.length > 0) {
      datagrams.push(current);
      datagramRecordGroups.push(currentRecs);
      current = Buffer.from(p);
      currentRecs = [rn];
    } else {
      current = current.length ? Buffer.concat([current, p]) : Buffer.from(p);
      currentRecs.push(rn);
    }
  }
  if (current.length) {
    datagrams.push(current);
    datagramRecordGroups.push(currentRecs);
  }

  // Explicit dest for one-shot responses; otherwise pin / retransmit reply-to
  const sendAddr = dest ?? this.getSendAddr();

  // Anti-amplification: before address validation, send ≤ 3× received (strict).
  // No exception for "first datagram" — CH receipt must provide budget for HRR.
  // Retransmits also consume budget via consumeSendBudget().
  // Pre-cookie: budget is owned by the RX source — never spend it toward another dest.
  if (
    this.role === "server" &&
    !this.addressValidated &&
    this.addressValidation === "dtls-cookie"
  ) {
    if (!this.antiAmpAllowsSendTo(sendAddr)) {
      throw new Error(
        `anti-amplification: dest is not budget owner (owner=${this.antiAmpBudgetPeerKey} dest=${sendAddr?.[0]}:${sendAddr?.[1]})`,
      );
    }
    const budget =
      ANTI_AMPLIFICATION_FACTOR * this.bytesReceived - this.bytesSent;
    let allowed = Math.max(0, budget);
    const limited: Buffer[] = [];
    const limitedGroups: AckRecordNumber[][] = [];
    for (let i = 0; i < datagrams.length; i++) {
      const d = datagrams[i];
      if (d.length > allowed) break;
      limited.push(d);
      limitedGroups.push(datagramRecordGroups[i]);
      allowed -= d.length;
    }
    if (limited.length === 0 && datagrams.length > 0) {
      throw new Error(
        `anti-amplification: budget exhausted (received=${this.bytesReceived} sent=${this.bytesSent} need=${datagrams[0].length})`,
      );
    }
    datagrams.length = 0;
    datagrams.push(...limited);
    datagramRecordGroups.length = 0;
    datagramRecordGroups.push(...limitedGroups);
  }

  // Separate copies for callback vs retransmit cache (Buffer contents are mutable)
  // Epoch-0 ServerHello is sent via carrier.send outside this function. Direct
  // UDP still transmits it there; SPED only sees onFlightCreated, so include SH
  // in the notify list (coalesce with the first encrypted datagram when it fits).
  const notifySources = spedNotifySources(
    fragmentPendingServerHello(this, mtu),
    datagrams,
    mtu,
  );
  const notifyPackets = notifySources.map((bytes, i) =>
    createHandshakeDatagram(bytes, flightId, i, retransmittable),
  );
  const cachePackets = datagrams.map((bytes, i) =>
    createHandshakeDatagram(bytes, flightId, i, retransmittable),
  );
  this.carrier.events.onFlightCreated?.(flightId, notifyPackets);

  if (retransmittable) {
    // New local outbound flight: next accepted peer HS record starts a new
    // remote flight → clear old remote ACK list at that point (RFC 9147 §7).
    // Do NOT clear receivedRecordNumbers here (local send ≠ remote ACK state).
    this.clearRemoteAckOnNextInbound = true;
    // Keep pre-chunk source for MTU-change re-fragmentation on retransmit
    this.pendingFlightSource = {
      fragments: fragments.map(
        (f) =>
          new FragmentedHandshake(
            f.msg_type,
            f.length,
            f.message_seq,
            f.fragment_offset,
            f.fragment_length,
            Buffer.from(f.fragment),
          ),
      ),
      epoch,
    };
    this.pendingFlight = cachePackets;
    this.pendingFlightRecordGroups = datagramRecordGroups.map((g) =>
      g.map((r) => ({ ...r })),
    );
    // Only records actually placed in sent datagrams (anti-amp may drop some)
    const sentKeys = new Set(
      datagramRecordGroups.flatMap((g) =>
        g.map((r) => `${r.epoch}:${r.sequenceNumber}`),
      ),
    );
    this.pendingFlightRecords = [];
    this.pendingFlightRecordBytes = [];
    for (let i = 0; i < packetRecords.length; i++) {
      const r = packetRecords[i];
      if (sentKeys.has(`${r.epoch}:${r.sequenceNumber}`)) {
        this.pendingFlightRecords.push({ ...r });
        // Independent copy so selective retransmit never mutates originals
        this.pendingFlightRecordBytes.push(Buffer.from(packets[i]));
      }
    }
    // Unpinned retransmit: remember reply-to for timer-driven resend
    // (trusted / post-cookie only — pre-cookie cookie HRR is one-shot below)
    if (!this.peerAddr && this.currentPeerAddr) {
      this.pendingFlightReplyTo = [...this.currentPeerAddr];
    }
    this.retransmitCount = 0;
    this.scheduleRetransmit();
  } else if (this.isPreCookieUnvalidatedServer()) {
    // Stateless cookie HRR / one-shot pre-cookie replies: never leave global
    // pendingFlight / pendingFlightReplyTo / RTO for unauthenticated sources
    // (would mix budget and dest across peers A/B).
    this.clearPendingFlight();
  }

  for (const pkt of cachePackets) {
    // Single-record datagrams must fit MTU (RFC 9147 / UDP path MTU)
    if (pkt.bytes.length > mtu) {
      throw new Error(
        `handshake record ${pkt.bytes.length} exceeds MTU ${mtu}`,
      );
    }
    // carrier.send copies bytes; budget still enforced here (peer-matched)
    if (!this.consumeSendBudget(pkt.bytes.length, sendAddr)) {
      throw new Error(
        `anti-amplification: budget exhausted on send (received=${this.bytesReceived} sent=${this.bytesSent} need=${pkt.bytes.length})`,
      );
    }
    await this.carrier.send(pkt, sendAddr);
  }
}

/**
 * SPED path MTU shrink: re-chunk pendingFlightSource under the current MTU
 * and publish via onFlightCreated (L1 replace). Does not write the datagram
 * to the transport — SPED carries the new L1 on the next Binding.
 */
export function refragmentPendingFlightIfNeeded(this: Dtls13Host): boolean {
  const src = this.pendingFlightSource;
  if (!src && !this.pendingServerHello && !this.pendingServerHelloSource) {
    return false;
  }
  const mtu = this.carrier.getMtu();
  const flightOversized = this.pendingFlight.some(
    (packet) => packet.bytes.length > mtu,
  );
  if (flightOversized && src) {
    return rebuildPendingFlightFromSource(this, src, mtu);
  }
  // Combined SH+first, or SH alone, can exceed MTU even when epoch-2
  // datagrams still fit. Rebuild notify (and re-chunk SH from source).
  return publishSpedNotifyFlight(this, mtu);
}

function publishSpedNotifyFlight(host: Dtls13Host, mtu: number): boolean {
  const datagrams = host.pendingFlight.map((packet) => packet.bytes);
  const serverHello = fragmentPendingServerHello(host, mtu);
  if (datagrams.length === 0 && serverHello.length === 0) {
    return false;
  }
  host.flightId += 1;
  const notifySources = spedNotifySources(serverHello, datagrams, mtu);
  const notifyPackets = notifySources.map((bytes, i) =>
    createHandshakeDatagram(bytes, host.flightId, i, true),
  );
  host.carrier.events.onFlightCreated?.(host.flightId, notifyPackets);
  return true;
}

function rebuildPendingFlightFromSource(
  host: Dtls13Host,
  src: NonNullable<Dtls13Host["pendingFlightSource"]>,
  mtu: number,
): boolean {
  const epoch = src.epoch;
  const maxFrag = epoch === 0 ? mtu - 13 - 12 : mtu - 5 - 12 - 1 - 16;
  if (maxFrag < 1) {
    return false;
  }

  const packets: Buffer[] = [];
  const packetRecords: AckRecordNumber[] = [];
  for (const fragment of src.fragments) {
    const chunks =
      fragment.fragment.length > maxFrag ? fragment.chunk(maxFrag) : [fragment];
    for (const chunk of chunks) {
      const hsBytes = chunk.serialize();
      if (epoch === 0) {
        const seq = host.recordSeqEpoch0++;
        packetRecords.push({ epoch: 0, sequenceNumber: seq });
        packets.push(
          serializePlaintextRecord(ContentType.handshake, 0, seq, hsBytes),
        );
      } else {
        const epochCtx = host.epochs.get(epoch);
        if (!epochCtx?.writeKeys) {
          return false;
        }
        const seq = epochCtx.writeSequence;
        packetRecords.push({ epoch, sequenceNumber: seq });
        packets.push(encryptRecord(hsBytes, ContentType.handshake, epochCtx));
      }
    }
  }

  const datagrams: Buffer[] = [];
  const datagramRecordGroups: AckRecordNumber[][] = [];
  let current: Buffer = Buffer.alloc(0);
  let currentRecs: AckRecordNumber[] = [];
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    const recordNumber = packetRecords[i]!;
    if (current.length + packet.length > mtu && current.length > 0) {
      datagrams.push(current);
      datagramRecordGroups.push(currentRecs);
      current = Buffer.from(packet);
      currentRecs = [recordNumber];
    } else {
      current = current.length
        ? Buffer.concat([current, packet])
        : Buffer.from(packet);
      currentRecs.push(recordNumber);
    }
  }
  if (current.length) {
    datagrams.push(current);
    datagramRecordGroups.push(currentRecs);
  }

  host.flightId += 1;
  const flightId = host.flightId;
  const notifySources = spedNotifySources(
    fragmentPendingServerHello(host, mtu),
    datagrams,
    mtu,
  );
  const notifyPackets = notifySources.map((bytes, i) =>
    createHandshakeDatagram(bytes, flightId, i, true),
  );
  host.carrier.events.onFlightCreated?.(flightId, notifyPackets);

  host.pendingFlight = datagrams.map((bytes, i) =>
    createHandshakeDatagram(bytes, flightId, i, true),
  );
  host.pendingFlightRecordGroups = datagramRecordGroups.map((group) =>
    group.map((record) => ({ ...record })),
  );
  host.pendingFlightRecords = packetRecords.map((record) => ({ ...record }));
  host.pendingFlightRecordBytes = packets.map((packet) => Buffer.from(packet));
  return true;
}

/**
 * Rebuild pendingFlight datagrams from still-pending individual record bytes.
 * After partial ACK, only un-ACK'd records are retransmitted (not whole mixed
 * datagrams that still contain ACK'd records).
 */
export function rebuildPendingFlightFromRecords(this: Dtls13Host): void {
  if (
    this.pendingFlightRecords.length === 0 ||
    this.pendingFlightRecordBytes.length !== this.pendingFlightRecords.length
  ) {
    this.pendingFlight = [];
    this.pendingFlightRecordGroups = [];
    return;
  }
  const mtu = this.carrier.getMtu();
  const datagrams: Buffer[] = [];
  const groups: AckRecordNumber[][] = [];
  let current = Buffer.alloc(0);
  let currentRecs: AckRecordNumber[] = [];
  for (let i = 0; i < this.pendingFlightRecordBytes.length; i++) {
    const p = this.pendingFlightRecordBytes[i];
    const rn = this.pendingFlightRecords[i];
    if (current.length + p.length > mtu && current.length > 0) {
      datagrams.push(current);
      groups.push(currentRecs);
      current = Buffer.from(p);
      currentRecs = [{ ...rn }];
    } else {
      current = current.length ? Buffer.concat([current, p]) : Buffer.from(p);
      currentRecs.push({ ...rn });
    }
  }
  if (current.length) {
    datagrams.push(current);
    groups.push(currentRecs);
  }
  this.pendingFlight = datagrams.map((bytes, i) =>
    createHandshakeDatagram(bytes, this.flightId, i, true),
  );
  this.pendingFlightRecordGroups = groups;
}

/**
 * Account outbound bytes and enforce 3× anti-amplification before address
 * validation (including retransmissions of HRR / incomplete flights).
 */
/**
 * @param dest Destination for peer-budget match (pre-cookie). When omitted,
 * uses getSendAddr() — retransmit must still match antiAmpBudgetPeerKey.
 */
export function consumeSendBudget(
  this: Dtls13Host,
  len: number,
  dest?: [string, number],
): boolean {
  if (
    this.role === "server" &&
    !this.addressValidated &&
    this.addressValidation === "dtls-cookie"
  ) {
    const to = dest ?? this.getSendAddr();
    if (!this.antiAmpAllowsSendTo(to)) {
      log(
        "consumeSendBudget blocked: dest is not anti-amp budget owner",
        this.antiAmpBudgetPeerKey,
        to,
      );
      return false;
    }
    const budget =
      ANTI_AMPLIFICATION_FACTOR * this.bytesReceived - this.bytesSent;
    if (len > budget) return false;
  }
  this.bytesSent += len;
  return true;
}

/**
 * All outbound DTLS records (handshake flights, retransmit, ACK, alerts)
 * must pass through this path so anti-amplification covers aggregate TX.
 * @returns false if budget blocked the send (caller must not assume wire TX).
 * @param dest Optional explicit peer for request/response (alerts / pre-cookie
 * HRR). When omitted, uses getSendAddr() (pin / retransmit reply-to).
 * Never route a response to pendingFlightReplyTo of a *different* source by
 * accident — callers handling the current datagram should pass currentPeerAddr.
 */
export async function sendWithBudget(
  this: Dtls13Host,

  record: Buffer,
  dest?: [string, number],
): Promise<boolean> {
  const to = dest ?? this.getSendAddr();
  if (!this.consumeSendBudget(record.length, to)) {
    log(
      "sendWithBudget blocked by anti-amplification",
      this.bytesReceived,
      this.bytesSent,
      record.length,
    );
    return false;
  }
  await this.options.transport.send(record, to);
  return true;
}

/**
 * Compute association RTO (RFC 9147 §5.8.2).
 * RTT known → 1.5 × RTT; unknown → 1000ms (400ms when DTLS-SRTP profile).
 * Exponential backoff on retransmitCount. ICE/SPED feed RTT via
 * carrier.updateRtt (Epic 2).
 */
export function computeRetransmitRtoMs(this: Dtls13Host): number {
  return computeDtlsRtoMs({
    rttMs: this.carrier.getRtt(),
    retransmitCount: this.retransmitCount,
    useSrtpProfile: !!(
      this.options.srtpProfiles && this.options.srtpProfiles.length > 0
    ),
  });
}

/**
 * Schedule RFC 9147 RTO for the current handshake flight.
 * `flightId` is the 1.3 equivalent of 1.2 `flightTxGeneration`: a newer
 * sendHandshakeFlight, version fallback (`closed`), or clearPendingFlight
 * must not let a queued timer retransmit or call fail().
 */
export function scheduleRetransmit(this: Dtls13Host) {
  this.cancelRetransmit?.();
  // Allow post-handshake retransmit (final flight / KeyUpdate) when connected
  if (
    this.closed ||
    (this.pendingFlight.length === 0 && !this.pendingServerHello)
  ) {
    return;
  }
  const rto = this.computeRetransmitRtoMs();
  const rtoGen = this.flightId;
  this.cancelRetransmit = this.carrier.schedule(rto, () => {
    if (this.closed || this.flightId !== rtoGen) return;
    void this.doRetransmit();
  });
}

export async function doRetransmit(this: Dtls13Host): Promise<void> {
  const rtoGen = this.flightId;
  if (
    this.closed ||
    (this.pendingFlight.length === 0 &&
      !this.pendingServerHello &&
      !this.pendingFlightSource)
  ) {
    return;
  }
  // Pre-cookie: never retransmit toward a dest that does not own the budget
  // (B's large CH must not fund RTO of A's pending HRR).
  if (this.isPreCookieUnvalidatedServer()) {
    const dest = this.getSendAddr();
    if (!this.antiAmpAllowsSendTo(dest)) {
      log(
        "retransmit suppressed: pending dest is not anti-amp budget owner",
        this.antiAmpBudgetPeerKey,
        dest,
      );
      this.clearPendingFlight();
      return;
    }
  }
  this.retransmitCount++;
  if (this.retransmitCount > this.maxRetransmit) {
    this.fail(new Error("DTLS 1.3 handshake retransmission exhausted"));
    return;
  }
  log("retransmit flight", this.flightId, this.retransmitCount);

  const mtu = this.carrier.getMtu();
  // RFC 9147: on PMTU reduction, re-fragment the same handshake message
  // bytes into smaller records (and optionally back off record size).
  const anyOversized =
    this.pendingFlightRecordBytes.some((b) => b.length > mtu) ||
    (this.pendingServerHello != null &&
      this.pendingServerHello.bytes.length > mtu);
  if (anyOversized && this.pendingFlightSource) {
    const savedCount = this.retransmitCount;
    const src = this.pendingFlightSource;
    const savedSh = this.pendingServerHello;
    try {
      // Rebuild flight under current MTU (new record sequence numbers)
      this.pendingServerHello = undefined;
      await this.sendHandshakeFlight(src.fragments, src.epoch, true);
      // Keep SH for retransmit if still pending (plaintext SH not re-chunked)
      this.pendingServerHello = savedSh;
      this.retransmitCount = savedCount;
      this.scheduleRetransmit();
      return;
    } catch (e) {
      log("re-fragment on MTU change failed", e);
      this.pendingServerHello = savedSh;
      this.retransmitCount = savedCount;
    }
  }

  // ServerHello is retransmitted with the encrypted flight until fully ACK'd
  const toSend = this.pendingServerHello
    ? [this.pendingServerHello, ...this.pendingFlight]
    : this.pendingFlight;
  const sendAddr = this.getSendAddr();
  for (const p of toSend) {
    if (p.bytes.length > mtu) {
      log("skip retransmit: record exceeds current MTU", p.bytes.length);
      continue;
    }
    if (!this.consumeSendBudget(p.bytes.length, sendAddr)) {
      log(
        "retransmit blocked by anti-amplification",
        this.bytesReceived,
        this.bytesSent,
      );
      break;
    }
    try {
      await this.carrier.send(p, sendAddr);
    } catch (e) {
      // Close / newer flight / version fallback while send was in flight.
      if (this.closed || this.flightId !== rtoGen) return;
      this.fail(e instanceof Error ? e : new Error(String(e)));
      return;
    }
  }
  if (this.closed || this.flightId !== rtoGen) return;
  this.scheduleRetransmit();
}

/**
 * Max RecordNumbers that fit in one ACK under current MTU / write epoch.
 * RFC 9147: ACK records must fit the path MTU estimate.
 */
export function maxAckRecordsForMtu(this: Dtls13Host): number {
  const mtu = this.carrier.getMtu();
  const ep =
    this.epochs.get(this.writeEpoch) ||
    this.epochs.get(2) ||
    this.epochs.get(3);
  const overhead =
    ep?.writeKeys != null ? ACK_ENCRYPTED_OVERHEAD : ACK_PLAINTEXT_OVERHEAD;
  const n = Math.floor((mtu - overhead) / ACK_RECORD_NUMBER_BYTES);
  return Math.max(1, Math.min(MAX_ACK_RECORD_NUMBERS, n));
}

/**
 * Send an ACK listing successfully accepted handshake records (RFC 9147 §7).
 * Empty record_numbers is allowed and prompts peer retransmission.
 * Prefers encrypted epoch (writeEpoch / 2 / 3); falls back to epoch-0 plaintext.
 * Count is clamped by dynamic MTU. Always budget-checked (no anti-amp bypass).
 */
export async function sendAck(
  this: Dtls13Host,
  opts?: { allowEmpty?: boolean },
): Promise<void> {
  const allowEmpty = opts?.allowEmpty === true;
  if (this.receivedRecordNumbers.length === 0 && !allowEmpty) {
    return;
  }
  const maxN = this.maxAckRecordsForMtu();
  // Prefer oldest unacked first so large flights drain front-to-back
  const sorted = [...this.receivedRecordNumbers].sort((a, b) =>
    a.epoch !== b.epoch
      ? a.epoch - b.epoch
      : a.sequenceNumber - b.sequenceNumber,
  );
  const numbers = sorted.slice(0, maxN);
  // Keep remainder for a subsequent ACK (do not drop unacked records)
  this.receivedRecordNumbers = sorted.slice(maxN);
  const ack = new DtlsAck(numbers);
  const body = ack.serialize();

  // Prefer encrypted ACK on current write epoch (handshake or app)
  // After protected keys exist, never fall back to epoch-0 plaintext ACK
  const ep =
    this.epochs.get(this.writeEpoch) ||
    this.epochs.get(2) ||
    this.epochs.get(3);
  let record: Buffer;
  if (ep?.writeKeys) {
    record = encryptRecord(body, ContentType.ack, ep);
  } else if (this.writeEpoch < 2 && !this.connected) {
    // Epoch 0 plaintext ACK only before handshake traffic keys exist
    const seq = this.recordSeqEpoch0++;
    record = serializePlaintextRecord(ContentType.ack, 0, seq, body);
  } else {
    // No usable write keys — put numbers back
    this.receivedRecordNumbers = [...numbers, ...this.receivedRecordNumbers];
    return;
  }
  if (record.length > this.carrier.getMtu()) {
    // Should not happen if maxAckRecordsForMtu is correct; drop one and retry
    log("ACK exceeds MTU; reducing record list", record.length);
    this.receivedRecordNumbers = [...numbers, ...this.receivedRecordNumbers];
    if (numbers.length > 1) {
      this.receivedRecordNumbers = this.receivedRecordNumbers.slice(1);
      await this.sendAck(opts);
    }
    return;
  }
  const ok = await this.sendWithBudget(record);
  if (!ok) {
    // Budget exhausted: put numbers back so a later ACK can retry
    this.receivedRecordNumbers = [...numbers, ...this.receivedRecordNumbers];
  }
}

/** Explicit empty ACK path (RFC 9147 §7: prompts peer retransmit). */
export async function sendEmptyAck(this: Dtls13Host): Promise<void> {
  await this.sendAck({ allowEmpty: true });
}

/**
 * @param dest Explicit response address for the peer that caused the alert.
 * Pre-cookie paths must pass currentPeerAddr so a fatal for B is not sent to A
 * via pendingFlightReplyTo from an earlier HRR.
 */
export async function sendFatalAlert(
  this: Dtls13Host,

  description: number,
  dest?: [string, number],
): Promise<void> {
  const alert = Buffer.from([2, description]); // fatal
  // Prefer explicit dest, then the datagram being processed, then pin/retransmit
  const to = dest ?? this.currentPeerAddr ?? this.getSendAddr();
  try {
    if (this.writeEpoch >= 2) {
      const ep = this.epochs.get(this.writeEpoch);
      if (ep?.writeKeys) {
        const record = encryptRecord(alert, ContentType.alert, ep);
        await this.sendWithBudget(record, to);
        return;
      }
    }
    const seq = this.recordSeqEpoch0++;
    const record = serializePlaintextRecord(ContentType.alert, 0, seq, alert);
    await this.sendWithBudget(record, to);
  } catch (e) {
    log("sendFatalAlert failed", e);
  }
}

export function alertDescForHandshakeError(
  this: Dtls13Host,
  err: Error,
): number {
  const fromProto = (err as { alertDescription?: number }).alertDescription;
  if (typeof fromProto === "number") return fromProto;
  const m = err.message;
  if (/verify_data|Finished|DecryptError|MAC/i.test(m)) {
    return AlertDesc.DecryptError;
  }
  if (
    /CertificateVerify|signature|certificate_request_context|BadCertificate|certificate/i.test(
      m,
    )
  ) {
    return AlertDesc.DecryptError;
  }
  if (
    /illegal|not negotiated|unsupported|unexpected|missing_extension/i.test(m)
  ) {
    return AlertDesc.IllegalParameter;
  }
  if (/no overlapping/i.test(m)) {
    return AlertDesc.HandshakeFailure;
  }
  return AlertDesc.HandshakeFailure;
}

/** Best-effort fatal alert on current write epoch (or epoch-0 plaintext). */
export async function failAuthenticatedHandshake(
  this: Dtls13Host,
  err: Error,
): Promise<void> {
  (err as Error & { dtlsAuthenticated?: boolean }).dtlsAuthenticated = true;
  const desc = this.alertDescForHandshakeError(err);
  await this.sendFatalAlert(desc);
  this.fail(err);
}

export async function sendProtocolVersionAlert(
  this: Dtls13Host,

  dest?: [string, number],
): Promise<void> {
  // alert level fatal(2), description protocol_version(70)
  const alert = Buffer.from([2, AlertDesc.ProtocolVersion]);
  const seq = this.recordSeqEpoch0++;
  const record = serializePlaintextRecord(ContentType.alert, 0, seq, alert);
  const to = dest ?? this.currentPeerAddr ?? this.getSendAddr();
  // Best-effort alert; budget may block pre-cookie
  try {
    await this.sendWithBudget(record, to);
  } catch {
    // ignore budget failures for optional alert
  }
  // Pre-cookie: do not tear down association (spoofed CH with bad versions)
  if (
    this.role === "server" &&
    this.addressValidation === "dtls-cookie" &&
    !this.addressValidated
  ) {
    log(
      "pre-cookie protocol_version alert sent without fail (unvalidated source)",
    );
    return;
  }
  this.fail(
    new ProtocolVersionError(
      "no overlapping DTLS 1.3 protocol version with peer",
    ),
  );
}

/**
 * Queue a successfully accepted handshake record for the next ACK
 * (dedupe + cap). Also marks it as accepted for replay re-ACK.
 * If this is the first record of a new remote flight (after we sent a local
 * flight), clear the previous flight's ACK list first (RFC 9147 §7).
 */
/**
 * @returns true if the caller should flush an intermediate ACK (accumulator full).
 */
export function noteHandshakeRecordForAck(
  this: Dtls13Host,

  epoch: number,
  sequenceNumber: number,
): boolean {
  if (this.clearRemoteAckOnNextInbound) {
    this.receivedRecordNumbers = [];
    this.clearRemoteAckOnNextInbound = false;
  }
  this.markHandshakeRecordAccepted(epoch, sequenceNumber);
  const exists = this.receivedRecordNumbers.some(
    (r) => r.epoch === epoch && r.sequenceNumber === sequenceNumber,
  );
  if (!exists) {
    this.receivedRecordNumbers.push({ epoch, sequenceNumber });
  }
  // Flush intermediate ACK before overflow so large flights remain ACKable
  // (RFC 9147: prefer unacked records; never silently drop them).
  return this.receivedRecordNumbers.length >= this.maxAckRecordsForMtu();
}

/**
 * Re-queue a previously accepted handshake record for ACK on replay.
 * Does nothing if the record was never successfully accepted.
 * @returns true if the record was re-queued (caller may sendAck).
 */
export function noteReplayForAck(
  this: Dtls13Host,
  epoch: number,
  sequenceNumber: number,
): boolean {
  if (!this.wasHandshakeRecordAccepted(epoch, sequenceNumber)) {
    return false;
  }
  const exists = this.receivedRecordNumbers.some(
    (r) => r.epoch === epoch && r.sequenceNumber === sequenceNumber,
  );
  if (!exists) {
    this.receivedRecordNumbers.push({ epoch, sequenceNumber });
  }
  return true;
}

/**
 * All epochs matching 2-bit wire epoch that have usable keys.
 * decryptRecord trials AEAD newest-first so epoch 3 vs 7 collisions work.
 */
