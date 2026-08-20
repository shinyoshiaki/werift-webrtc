import { HandshakeType } from "../../handshake/const";
import { peerKeyFromAddr } from "../../handshake/extensions/cookie";
import { Alert } from "../../handshake/message/alert";
import {
  type AckRecordNumber,
  DtlsAck,
  remainingAfterAck,
} from "../../handshake/message/tls13/ack";
import { AlertDesc, ContentType } from "../../record/const";
import { FragmentedHandshake } from "../../record/message/fragment";
import {
  DtlsDecodeError,
  DtlsReplayError,
  type EpochProtection,
  encryptRecord,
  parseNextRecord,
  serializePlaintextRecord,
} from "../../record/v1_3/record";
import {
  DtlsProtocolError,
  DtlsVersionSelected,
  ProtocolVersionError,
} from "../../version";
import { Dtls13FlightTx } from "./flight-tx";
import {
  FRAGMENT_TTL_MS,
  MAX_ACK_RECORD_NUMBERS,
  MAX_FRAGMENTS_PER_MESSAGE,
  MAX_FRAGMENT_BUFFER_BYTES,
  MAX_FRAGMENT_BUFFER_MESSAGES,
  MAX_HS_MESSAGE_BYTES,
  log,
} from "./types";

/**
 * Record receive path: UDP datagrams → records → handshake reassembly → dispatch.
 * Inbound arrows in index.ts Figure 3; AEAD failures silent-drop, auth failures fatal.
 */
export abstract class Dtls13RecordRx extends Dtls13FlightTx {
  /** Flight routing — implemented in HandshakeFlights (Figure 3). */
  protected abstract dispatchHandshake(
    hs: import("../../record/message/fragment").FragmentedHandshake,
    epoch: number,
  ): Promise<void>;

  /** Implemented in HandshakeFlights — used after ACK'ing peer KeyUpdate(request). */
  protected abstract keyUpdate(requestUpdate?: boolean): Promise<void>;

  protected handleDatagram = (
    data: Buffer,
    addr?: [string, number] | { address?: string; port?: number } | string,
  ): void => {
    if (this.closed) return;
    // Serialize RX so concurrent UDP datagrams cannot race key install / inbox
    const buf = Buffer.from(data);
    const src = addr ?? this.peerFromTransport();
    const peer = peerKeyFromAddr(src);
    const peerAddr = this.addrToTuple(src);
    this.rxChain = this.rxChain
      .then(() => this.handleDatagramAsync(buf, peer, peerAddr))
      .catch((e) => {
        // ProtocolVersionError / authenticated handshake failures already call fail()
        // or rethrow after failAuthenticatedHandshake. Unauthenticated errors are
        // discarded inside handleDatagramAsync and should not reach here often.
        if (
          e instanceof ProtocolVersionError ||
          e instanceof DtlsVersionSelected ||
          e instanceof DtlsProtocolError ||
          (e instanceof Error && e.name === "ProtocolVersionError") ||
          (e instanceof Error && e.name === "DtlsVersionSelected") ||
          (e instanceof Error && e.name === "DtlsProtocolError") ||
          (e instanceof Error && (e as any).dtlsAuthenticated === true)
        ) {
          try {
            this.fail(e instanceof Error ? e : new Error(String(e)));
          } catch {
            this.onError.execute(e instanceof Error ? e : new Error(String(e)));
          }
          return;
        }
        log("handleDatagram chain: silent discard", e);
      });
  };

  protected async handleDatagramAsync(
    data: Buffer,
    peerKey?: string,
    peerAddr?: [string, number],
  ): Promise<void> {
    if (this.closed) return;

    // Epic 1 peer gate:
    // - datagram-address: once provisional/pin, only that 5-tuple may deliver
    // - authenticated-single-peer: transport identity is the peer; do not drop
    //   addressless or alternate 5-tuple RX (ICE never exposes stable rinfo)
    if (!this.allowsAssociationPeer(peerKey)) {
      log(
        "drop datagram from non-association peer",
        peerKey,
        this.expectedPeerKey(),
        this.peerIdentityMode,
      );
      return;
    }

    // Temporary source for this datagram only (reply / cookie binding)
    this.currentPeerKey = peerKey;
    this.currentPeerAddr = peerAddr;
    this.currentDatagramBytes = data.length;
    this.currentDatagramCounted = false;
    // Already-associated peer: count RX for anti-amp immediately
    const expected = this.expectedPeerKey();
    if (expected && peerKey === expected) {
      this.bytesReceived += data.length;
      this.currentDatagramCounted = true;
    }

    try {
      await this.processDatagramRecords(data);
    } finally {
      this.currentPeerKey = undefined;
      this.currentPeerAddr = undefined;
      this.currentDatagramBytes = 0;
      this.currentDatagramCounted = false;
    }
  }

  /** Parse and dispatch all records in one UDP datagram. */
  protected async processDatagramRecords(data: Buffer): Promise<void> {
    this.evictExpiredFragments();
    let offset = 0;
    while (offset < data.length) {
      if (this.closed) return;
      let rec;
      try {
        rec = parseNextRecord(data.subarray(offset), (low) =>
          this.resolveEpochCandidates(low),
        );
      } catch (e) {
        // Replay: re-ACK only if we previously successfully accepted this HS record
        // (anti-replay alone must not imply the record is acknowledged).
        if (
          e instanceof DtlsReplayError ||
          (e as Error)?.name === "DtlsReplayError"
        ) {
          const re = e as DtlsReplayError;
          log("drop replay/too-old record", re.message);
          if (re.consumed > 0) {
            offset += re.consumed;
            if (
              re.contentType === ContentType.handshake &&
              this.noteReplayForAck(re.epoch, re.sequenceNumber)
            ) {
              void this.sendAck().catch((err) =>
                log("re-ACK after replay failed", err),
              );
            }
            continue;
          }
          return;
        }
        // Decode / AEAD / missing-key errors from unauthenticated UDP: silent drop
        // (RFC 9147: invalid records are discarded without alert when not authenticated)
        log("drop invalid record", e instanceof Error ? e.message : String(e));
        return;
      }
      if (!rec) break;
      offset += rec.consumed;
      try {
        // Order is critical (RFC 9147 §7):
        //   1) process/accept handshake content
        //   2) note record for current remote flight ACK list
        //   3) if handler requested ACK after this record, sendAck()
        // queueMicrotask cannot be used for (3): microtasks run before this
        // continuation, so Finished would be missing from the ACK.
        if (rec.kind === "plaintext") {
          const accepted = await this.onPlaintextRecordAsync(rec);
          if (accepted && rec.contentType === ContentType.handshake) {
            await this.finishHandshakeRecordAck(rec.epoch, rec.sequenceNumber);
          }
        } else {
          const accepted = await this.onCiphertextRecordAsync(rec);
          if (accepted && rec.contentType === ContentType.handshake) {
            await this.finishHandshakeRecordAck(rec.epoch, rec.sequenceNumber);
          }
        }
      } catch (e) {
        // Protocol version / dual selection / negotiation failures surface
        if (
          e instanceof ProtocolVersionError ||
          e instanceof DtlsVersionSelected ||
          e instanceof DtlsProtocolError ||
          (e instanceof Error && e.name === "ProtocolVersionError") ||
          (e instanceof Error && e.name === "DtlsVersionSelected") ||
          (e instanceof Error && e.name === "DtlsProtocolError")
        ) {
          if (e instanceof DtlsVersionSelected) throw e;
          if (e instanceof ProtocolVersionError) {
            // Dual-stack selection signals are handled by association layer
            if (this.isPreCookieUnvalidatedServer()) {
              log(
                "pre-cookie protocol_version from unvalidated source (no fail)",
                e.message,
              );
              return;
            }
            throw e;
          }
          // DtlsProtocolError
          if (this.isPreCookieUnvalidatedServer() && rec.kind === "plaintext") {
            // RFC 9147: invalid cookie → illegal_parameter alert to this source,
            // but never fail() the association (other attempts must survive).
            const pe = e as DtlsProtocolError;
            if (
              pe.alertDescription === AlertDesc.IllegalParameter ||
              /invalid DTLS cookie|illegal_parameter/i.test(pe.message)
            ) {
              try {
                // Must target the source of *this* datagram (B), never A's
                // pendingFlightReplyTo from an earlier HRR.
                await this.sendFatalAlert(
                  pe.alertDescription ?? AlertDesc.IllegalParameter,
                  this.currentPeerAddr,
                );
              } catch {
                // best-effort alert
              }
            }
            log(
              "pre-cookie protocol error from unvalidated source (no fail)",
              pe.message,
            );
            return;
          }
          await this.failAuthenticatedHandshake(
            e instanceof Error ? e : new Error(String(e)),
          );
          return;
        }
        // AEAD already succeeded for ciphertext → authenticated content.
        // Crypto/transcript failures must fatal-alert and fail() immediately
        // (not wait for peer retransmit timeout).
        if (rec.kind === "ciphertext") {
          await this.failAuthenticatedHandshake(
            e instanceof Error ? e : new Error(String(e)),
          );
          return;
        }
        // Plaintext epoch-0: promote local negotiation/semantic failures, but
        // never fail() the association before cookie validation (dtls-cookie).
        if (
          e instanceof Error &&
          /illegal_parameter|handshake_failure|missing_extension|protocol|no overlapping|not offered|not allowed|mismatch|forbidden|unsolicited|unsupported cipher|unsupported version|signature scheme|all-zero|low-order|invalid point|ECDH|key_share/i.test(
            e.message,
          )
        ) {
          if (this.isPreCookieUnvalidatedServer()) {
            log(
              "pre-cookie semantic error from unvalidated source (no fail)",
              e.message,
            );
            return;
          }
          await this.failAuthenticatedHandshake(
            e instanceof DtlsProtocolError
              ? e
              : new DtlsProtocolError(e.message),
          );
          return;
        }
        log(
          "drop unauthenticated plaintext process error",
          e instanceof Error ? e.message : String(e),
        );
        return;
      }
    }
  }

  /**
   * After AEAD-validated (or otherwise authenticated) handshake processing fails:
   * send a fatal alert and tear down. Marks error so outer handlers do not
   * treat it as forged-UDP discard.
   */
  protected resolveEpochCandidates(low: number): EpochProtection[] {
    const withRead: EpochProtection[] = [];
    const withWriteOnly: EpochProtection[] = [];
    for (const ep of this.epochs.values()) {
      if ((ep.epoch & 0x03) !== low) continue;
      if (ep.readKeys) withRead.push(ep);
      else if (ep.writeKeys) withWriteOnly.push(ep);
    }
    // Prefer read-key epochs; include write-only as last resort (e.g. ACK demux)
    return [...withRead, ...withWriteOnly].sort((a, b) => b.epoch - a.epoch);
  }

  /**
   * After a handshake record is accepted: note for ACK, then optionally ACK and
   * post-ACK actions (KeyUpdate response). Order is fixed so Finished/KeyUpdate
   * record numbers are present in the ACK (RFC 9147 §7 / §8).
   */
  protected async finishHandshakeRecordAck(
    epoch: number,
    sequenceNumber: number,
  ): Promise<void> {
    const needIntermediate = this.noteHandshakeRecordForAck(
      epoch,
      sequenceNumber,
    );
    // Intermediate ACK when accumulator is full (large fragmented Certificate)
    if (needIntermediate && !this.ackAfterCurrentRecord) {
      await this.sendAck();
    }
    if (this.ackAfterCurrentRecord) {
      this.ackAfterCurrentRecord = false;
      // Drain all pending ACK numbers (may need multiple MTU-sized ACKs)
      while (this.receivedRecordNumbers.length > 0) {
        await this.sendAck();
      }
      // RFC 9147: response KeyUpdate is not an implicit ACK of peer KeyUpdate.
      // If our own KeyUpdate is still un-ACKed, defer the response until after
      // handleAck → applyPendingKeyUpdateWrite (crossed update_requested).
      if (this.keyUpdateResponseAfterAck) {
        this.keyUpdateResponseAfterAck = false;
        if (this.pendingKeyUpdateWrite) {
          this.deferredKeyUpdateResponse = true;
          log("defer KeyUpdate response until own KeyUpdate is ACK'd");
        } else {
          try {
            await this.keyUpdate(false);
          } catch (e) {
            this.fail(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }
    }
  }

  /**
   * @returns true if handshake content was accepted (reassembled and/or queued)
   * so the containing DTLS record may be listed in a subsequent ACK.
   */
  /**
   * True once we have (or had) protected traffic keys — epoch-0 ACK/alert must
   * not affect protected state (RFC 9147).
   */
  protected hasProtectedWriteKeys(): boolean {
    return this.writeEpoch >= 2 || this.connected;
  }

  protected async onPlaintextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    fragment: Buffer;
  }): Promise<boolean> {
    // Only epoch 0 plaintext is valid for DTLS 1.3 handshake bootstrap
    if (rec.epoch !== 0) {
      log("drop plaintext with non-zero epoch", rec.epoch);
      return false;
    }
    // Epoch-0 ACK/alert is plaintext (unauthenticated AEAD).
    // After protected keys: never process (forged close / retransmit DoS).
    if (
      this.hasProtectedWriteKeys() &&
      (rec.contentType === ContentType.ack ||
        rec.contentType === ContentType.alert)
    ) {
      log("drop unauthenticated epoch-0 ACK/alert after protected state");
      return false;
    }
    if (rec.contentType === ContentType.alert) {
      // Pre-keys: only accept from an associated peer (client pin at connect,
      // post-cookie provisional/pin, or authenticated-single-peer / ICE where
      // the transport is the identity and no 5-tuple pin exists).
      // Server pre-cookie datagram-address: drop (listener DoS).
      if (!this.hasAssociationPeerAuth()) {
        log(
          "drop epoch-0 alert from unassociated peer (no association fatal)",
          this.currentPeerKey,
          this.expectedPeerKey(),
        );
        return false;
      }
      if (!this.allowsAssociationPeer(this.currentPeerKey)) {
        log(
          "drop epoch-0 alert from non-association peer",
          this.currentPeerKey,
          this.expectedPeerKey(),
        );
        return false;
      }
      this.handleAlert(rec.fragment, 0, rec.sequenceNumber);
      return false;
    }
    if (rec.contentType === ContentType.ack) {
      // Pre-keys empty/forged ACK from random sources: only associated peer.
      const expected = this.expectedPeerKey();
      if (!expected || !this.allowsAssociationPeer(this.currentPeerKey)) {
        log("drop epoch-0 ACK from unassociated peer");
        return false;
      }
      this.handleAck(rec.fragment, 0);
      return false;
    }
    if (rec.contentType === ContentType.handshake) {
      // After fully connected, ignore late epoch-0 handshake (except soft dual path)
      if (this.connected) {
        log("drop epoch-0 handshake after connected");
        return false;
      }
      if (rec.fragment.length === 0) {
        // Epoch-0 empty HS is noise; do not fail pre-cookie association
        log("drop empty epoch-0 handshake content");
        return false;
      }
      return this.processHandshakeBytes(rec.fragment, 0);
    }
    return false;
  }

  /**
   * @returns true if handshake content was accepted for ACK purposes.
   */
  protected async onCiphertextRecordAsync(rec: {
    contentType: number;
    epoch: number;
    sequenceNumber: number;
    content: Buffer;
  }): Promise<boolean> {
    switch (rec.contentType) {
      case ContentType.handshake:
        // RFC 8446: zero-length Handshake after deprotection → unexpected_message
        if (rec.content.length === 0) {
          throw new DtlsProtocolError(
            "unexpected_message: empty handshake content after AEAD",
            AlertDesc.UnexpectedMessage,
          );
        }
        return this.processHandshakeBytes(rec.content, rec.epoch);
      case ContentType.applicationData:
        // RFC 9147: ignore data with (epoch,seq) greater than close_notify's
        // (not mere receive order — UDP may reorder)
        if (this.peerCloseBoundary) {
          const b = this.peerCloseBoundary;
          if (
            rec.epoch > b.epoch ||
            (rec.epoch === b.epoch && rec.sequenceNumber > b.sequenceNumber)
          ) {
            log(
              "ignore application data after close_notify boundary",
              rec.epoch,
              rec.sequenceNumber,
            );
            return false;
          }
        }
        if (!this.connected) {
          // UDP reorder: epoch-3 app data before markConnected.
          // Bound buffer to prevent pre-Finished memory DoS (RFC 9147: buffer or discard).
          if (
            this.earlyAppData.length >= this.maxEarlyAppDataRecords ||
            this.earlyAppDataBytes + rec.content.length >
              this.maxEarlyAppDataBytes
          ) {
            log(
              "drop early app data: buffer limit",
              this.earlyAppData.length,
              this.earlyAppDataBytes,
            );
            return false;
          }
          this.earlyAppData.push(rec.content);
          this.earlyAppDataBytes += rec.content.length;
          return false;
        }
        this.onData.execute(rec.content);
        return false;
      case ContentType.ack:
        this.handleAck(rec.content, rec.epoch);
        return false;
      case ContentType.alert:
        // RFC 8446: zero-length Alert after deprotection → unexpected_message
        if (rec.content.length === 0) {
          throw new DtlsProtocolError(
            "unexpected_message: empty alert content after AEAD",
            AlertDesc.UnexpectedMessage,
          );
        }
        this.handleAlert(rec.content, rec.epoch, rec.sequenceNumber);
        return false;
      default:
        // AEAD-authenticated unknown type is fatal (not silent ignore)
        throw new DtlsProtocolError(
          `unexpected_message: unexpected content type ${rec.contentType} after AEAD`,
          AlertDesc.UnexpectedMessage,
        );
    }
  }

  /**
   * TLS 1.3 / RFC 8446 alert handling:
   * - close_notify: peer write closed at (epoch,seq); data after that pair ignored
   * - user_canceled: closure alert (warning); wait for close_notify
   * - other error descriptions: fatal regardless of legacy level
   * - malformed / truncated alert → decode_error fatal
   */
  protected handleAlert(
    fragment: Buffer,
    receivedEpoch: number,
    sequenceNumber = 0,
  ) {
    // Epoch-0: only reached when onPlaintextRecord verified associated peer
    // and pre-protected-keys. Epoch>0: AEAD-authenticated.
    if (fragment.length < 2) {
      // Unauthenticated truncated alert must not kill association.
      if (receivedEpoch === 0) {
        log("drop truncated epoch-0 alert");
        return;
      }
      this.fail(new Error("decode_error: truncated alert"));
      return;
    }
    let alert: Alert;
    try {
      alert = Alert.deSerialize(fragment);
    } catch {
      if (receivedEpoch === 0) {
        log("drop malformed epoch-0 alert");
        return;
      }
      this.fail(new Error("decode_error: malformed alert"));
      return;
    }
    log(
      "alert",
      alert.level,
      alert.description,
      "epoch",
      receivedEpoch,
      "seq",
      sequenceNumber,
    );

    if (alert.description === AlertDesc.CloseNotify) {
      // RFC 9147: record epoch/seq boundary for reordered app data; then align
      // public lifecycle with local close() (onClose, timers, connected=false).
      // Epoch>0: AEAD-authenticated. Epoch-0 only if pre-keys + associated peer
      // (onPlaintextRecord gate); post-keys epoch-0 never reaches here.
      log("peer close_notify", receivedEpoch, sequenceNumber);
      this.onPeerCloseNotify(receivedEpoch, sequenceNumber);
      return;
    }

    if (alert.description === AlertDesc.UserCanceled) {
      // Closure alert (typically warning); often followed by close_notify
      log("peer user_canceled");
      return;
    }

    if (alert.description === AlertDesc.ProtocolVersion) {
      this.fail(
        new ProtocolVersionError(
          "peer rejected protocol version (alert protocol_version)",
        ),
      );
      return;
    }

    // TLS 1.3: error alerts are fatal regardless of AlertLevel
    this.fail(
      new Error(
        `fatal alert ${alert.description} (${AlertDesc[alert.description] ?? "unknown"})`,
      ),
    );
  }

  /**
   * @param receivedEpoch epoch of the ACK record itself.
   * Higher-epoch RecordNumbers are ignored (not used to ACK protected flights).
   * RFC 9147 Erratum 8108 (Reported, not verified) would terminate with
   * illegal_parameter instead; this stack follows verified errata only.
   */
  protected handleAck(content: Buffer, receivedEpoch: number) {
    try {
      const ack = DtlsAck.deSerialize(content);
      log("received ACK", ack.recordNumbers.length, "on epoch", receivedEpoch);
      if (this.pendingFlightRecords.length === 0 && !this.pendingServerHello) {
        return;
      }
      // RFC 9147 §7: empty ACK acknowledges nothing — retransmit unacked flight
      // Do not let unauthenticated epoch-0 empty ACKs drive retransmit once protected.
      if (ack.recordNumbers.length === 0) {
        if (receivedEpoch === 0 && this.hasProtectedWriteKeys()) {
          log("ignore empty epoch-0 ACK after protected state");
          return;
        }
        log("empty ACK: retransmit pending flight (does not clear)");
        if (this.pendingFlight.length > 0 || this.pendingServerHello) {
          void this.doRetransmit();
        }
        return;
      }
      // RFC 9147: do not apply RecordNumbers whose epoch exceeds the ACK's
      // own epoch (blocks a plaintext ACK from completing an encrypted flight).
      const applicable = ack.recordNumbers.filter(
        (r) => r.epoch <= receivedEpoch,
      );
      if (applicable.length === 0) {
        log("ACK ignored: all record_numbers exceed received epoch");
        return;
      }
      if (applicable.length < ack.recordNumbers.length) {
        log(
          "ACK filtered higher-epoch record_numbers",
          ack.recordNumbers.length - applicable.length,
        );
      }
      const before = this.pendingFlightRecords.length;
      // Drop ACK'd records (and their wire bytes) so retransmit never resends them
      if (
        this.pendingFlightRecordBytes.length ===
        this.pendingFlightRecords.length
      ) {
        const acked = new Set(
          applicable.map((r) => `${r.epoch}:${r.sequenceNumber}`),
        );
        const keptRecs: AckRecordNumber[] = [];
        const keptBytes: Buffer[] = [];
        for (let i = 0; i < this.pendingFlightRecords.length; i++) {
          const r = this.pendingFlightRecords[i];
          if (!acked.has(`${r.epoch}:${r.sequenceNumber}`)) {
            keptRecs.push(r);
            keptBytes.push(this.pendingFlightRecordBytes[i]);
          }
        }
        this.pendingFlightRecords = keptRecs;
        this.pendingFlightRecordBytes = keptBytes;
      } else {
        this.pendingFlightRecords = remainingAfterAck(
          this.pendingFlightRecords,
          applicable,
        );
        this.pendingFlightRecordBytes = [];
      }
      // Rebuild datagrams from remaining individual records only (selective TX)
      this.rebuildPendingFlightFromRecords();
      if (this.pendingFlightRecords.length === before) {
        log("ACK ignored: no pending flight records matched");
        return;
      }
      if (this.pendingFlightRecords.length > 0) {
        log(
          "partial ACK: still pending",
          this.pendingFlightRecords.length,
          "of",
          before,
        );
        // Nudge retransmit timer so unacked records go out promptly
        this.scheduleRetransmit();
        return;
      }
      // Fully ACK'd (local outbound flight). Do not clear receivedRecordNumbers —
      // that tracks remote inbound records still needing ACK emission.
      this.clearPendingFlight();
      // RFC 9147 §8: only after KeyUpdate is ACK'd may we send with new keys
      this.applyPendingKeyUpdateWrite();
      // Crossed update_requested: send deferred response now that own KU is ACK'd
      if (this.deferredKeyUpdateResponse && !this.pendingKeyUpdateWrite) {
        this.deferredKeyUpdateResponse = false;
        void this.keyUpdate(false).catch((e) =>
          this.fail(e instanceof Error ? e : new Error(String(e))),
        );
      }
    } catch (e) {
      log("bad ACK", e);
    }
  }

  /**
   * @returns true if at least one handshake fragment was accepted (for ACK).
   */
  protected async processHandshakeBytes(
    raw: Buffer,
    epoch: number,
  ): Promise<boolean> {
    let offset = 0;
    let accepted = false;
    while (offset < raw.length) {
      const remaining = raw.length - offset;
      if (remaining === 0) break;
      if (remaining < 12) {
        throw new DtlsDecodeError(
          `handshake header truncated: need 12 bytes, have ${remaining}`,
        );
      }
      // fragment_length is at offset+9 (3 bytes) within 12-byte header
      const fragmentLength = raw.readUIntBE(offset + 9, 3);
      const total = 12 + fragmentLength;
      if (remaining < total) {
        throw new DtlsDecodeError(
          `handshake fragment truncated: need ${total}, have ${remaining}`,
        );
      }
      const hs = FragmentedHandshake.deSerialize(
        raw.subarray(offset, offset + total),
      );
      if (hs.fragment_length !== hs.fragment.length) {
        throw new DtlsDecodeError(
          `handshake fragment_length mismatch: header ${hs.fragment_length}, body ${hs.fragment.length}`,
        );
      }
      offset += total;
      // Epoch 0: coarse allowlist only (unauthenticated DoS surface).
      // Epoch ≥ 2: AEAD-authenticated — always pass to the handshake state
      // machine so wrong-order / wrong-role types become unexpected_message
      // (RFC 8446), not silent drop.
      if (epoch === 0 && !this.isAllowedHandshake(hs.msg_type, epoch)) {
        log("drop disallowed epoch-0 handshake", hs.msg_type);
        continue;
      }
      const complete = this.reassemble(hs);
      accepted = true;
      if (complete) {
        // Queue by message_seq for reorder safety (RFC 9147 §5.2)
        await this.enqueueHandshake(complete, epoch);
      }
    }
    return accepted;
  }

  /**
   * Epoch-0 only: restrict which handshake types may be processed without AEAD.
   * Authenticated epochs rely on `isExpectedHandshakeType` in dispatchHandshake.
   */
  protected isAllowedHandshake(msgType: number, epoch: number): boolean {
    // Epoch 0 plaintext: only ClientHello / ServerHello (HRR) / HelloVerifyRequest
    if (epoch === 0) {
      if (this.role === "server") {
        return msgType === HandshakeType.client_hello_1;
      }
      return (
        msgType === HandshakeType.server_hello_2 ||
        msgType === HandshakeType.hello_verify_request_3
      );
    }
    // Authenticated epochs: defer to state machine
    return true;
  }

  protected async enqueueHandshake(
    hs: FragmentedHandshake,
    epoch: number,
  ): Promise<void> {
    // Unassociated server (no provisional/pin): a new ClientHello is a fresh
    // cookie attempt from any source — do not treat message_seq 0 as a duplicate
    // of a prior attacker's abandoned CH (return-routability / DoS resistance).
    if (
      this.role === "server" &&
      !this.expectedPeerKey() &&
      hs.msg_type === HandshakeType.client_hello_1 &&
      this.hsPhase === "wait_client_hello"
    ) {
      if (hs.message_seq < this.nextReceiveSeq) {
        this.nextReceiveSeq = hs.message_seq;
        this.handshakeInbox.clear();
      }
    }
    const seq = hs.message_seq;
    if (seq < this.nextReceiveSeq) {
      // Duplicate handshake message (flight retransmit) — re-ACK so sender advances
      void this.sendAck().catch((e) =>
        log("re-ACK on dup handshake failed", e),
      );
      return;
    }
    if (seq > this.nextReceiveSeq) {
      this.handshakeInbox.set(seq, hs);
      // Bound inbox size
      if (this.handshakeInbox.size > 32) {
        throw new Error(
          "handshake inbox overflow (too many out-of-order messages)",
        );
      }
      return;
    }
    // seq === nextReceiveSeq
    await this.dispatchHandshake(hs, epoch);
    this.nextReceiveSeq += 1;
    // Drain consecutive queued messages
    while (this.handshakeInbox.has(this.nextReceiveSeq)) {
      const next = this.handshakeInbox.get(this.nextReceiveSeq)!;
      this.handshakeInbox.delete(this.nextReceiveSeq);
      await this.dispatchHandshake(next, epoch);
      this.nextReceiveSeq += 1;
    }
  }

  protected evictExpiredFragments(): void {
    const now = Date.now();
    for (const [key, entry] of this.fragmentBuffer) {
      if (now - entry.createdAt > FRAGMENT_TTL_MS) {
        // Accounting charges `total` when the entry is created (see reassemble).
        // coveredBytes tracks filled range for diagnostics; free with total.
        this.fragmentBufferBytes -= entry.total;
        this.fragmentBuffer.delete(key);
      }
    }
    if (this.fragmentBufferBytes < 0) this.fragmentBufferBytes = 0;
  }

  protected reassemble(hs: FragmentedHandshake): FragmentedHandshake | null {
    // Strict range checks on every fragment
    if (hs.length < 0 || hs.length > MAX_HS_MESSAGE_BYTES) {
      throw new Error(
        `handshake message length ${hs.length} exceeds limit ${MAX_HS_MESSAGE_BYTES}`,
      );
    }
    if (hs.fragment_length !== hs.fragment.length) {
      throw new Error("fragment_length does not match buffer size");
    }
    if (
      hs.fragment_offset < 0 ||
      hs.fragment_length < 0 ||
      hs.fragment_offset + hs.fragment_length > hs.length
    ) {
      throw new Error(
        `invalid fragment range offset=${hs.fragment_offset} length=${hs.fragment_length} total=${hs.length}`,
      );
    }

    if (hs.fragment_length === hs.length && hs.fragment_offset === 0) {
      return hs;
    }

    this.evictExpiredFragments();

    const key = `${hs.msg_type}:${hs.message_seq}:${hs.length}`;
    let entry = this.fragmentBuffer.get(key);
    if (!entry) {
      if (this.fragmentBuffer.size >= MAX_FRAGMENT_BUFFER_MESSAGES) {
        throw new Error("fragment buffer: too many incomplete messages");
      }
      if (this.fragmentBufferBytes + hs.length > MAX_FRAGMENT_BUFFER_BYTES) {
        throw new Error("fragment buffer: total bytes exceeded");
      }
      entry = {
        parts: [],
        total: hs.length,
        createdAt: Date.now(),
        coveredBytes: 0,
      };
      this.fragmentBuffer.set(key, entry);
      this.fragmentBufferBytes += hs.length;
    }

    if (entry.parts.length >= MAX_FRAGMENTS_PER_MESSAGE) {
      throw new Error("fragment buffer: too many fragments for one message");
    }

    // Reject conflicting overlaps; allow exact retransmission of same bytes
    for (const prev of entry.parts) {
      const a0 = prev.fragment_offset;
      const a1 = prev.fragment_offset + prev.fragment_length;
      const b0 = hs.fragment_offset;
      const b1 = hs.fragment_offset + hs.fragment_length;
      const overlapStart = Math.max(a0, b0);
      const overlapEnd = Math.min(a1, b1);
      if (overlapStart < overlapEnd) {
        for (let i = overlapStart; i < overlapEnd; i++) {
          const prevByte = prev.fragment[i - a0];
          const newByte = hs.fragment[i - b0];
          if (prevByte !== newByte) {
            throw new Error("overlapping fragment with conflicting data");
          }
        }
      }
    }

    entry.parts.push(hs);

    // Coverage check + keep coveredBytes in sync for diagnostics / accounting
    const covered = new Uint8Array(entry.total);
    let coveredCount = 0;
    for (const p of entry.parts) {
      for (let i = 0; i < p.fragment_length; i++) {
        const idx = p.fragment_offset + i;
        if (!covered[idx]) {
          covered[idx] = 1;
          coveredCount++;
        }
      }
    }
    entry.coveredBytes = coveredCount;
    if (coveredCount < entry.total) return null;

    this.fragmentBuffer.delete(key);
    // Free the reservation charged at entry creation (full message length)
    this.fragmentBufferBytes -= entry.total;
    if (this.fragmentBufferBytes < 0) this.fragmentBufferBytes = 0;
    return FragmentedHandshake.assemble(entry.parts);
  }
}
