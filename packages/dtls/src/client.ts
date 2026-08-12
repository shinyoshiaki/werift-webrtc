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
import { peerKeyFromAddr } from "./handshake/extensions/cookie";
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
import type { Address } from "./imports/common";
import { debug } from "./imports/common";
import { AlertDesc, ContentType } from "./record/const";
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
  wireVersionToNumber,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/client.ts : log");

/**
 * Dual-stack association phase machine.
 * - none: initial / not dual-probing
 * - probing: after unauth HVR; parked 1.3 CH-A + 1.2 cookie path in parallel
 * - committed12 / committed13: version finalized by SH/HRR (never by HVR alone)
 * - closed: hard association teardown; all RX and candidates dead
 *
 * Ownership:
 *   Association owns transport RX + carrier.inject for the whole dual lifecycle
 *   (probing → committed → closed). Engines never steal RX on unpark.
 */
export type DualAssociationPhase =
  | "none"
  | "probing"
  | "committed12"
  | "committed13"
  | "closed";

/** @internal alias used by implementation fields */
type DualPhase = DualAssociationPhase;

export class DtlsClient extends DtlsSocket {
  /**
   * Dual association phase. Final version is confirmed by ServerHello
   * (1.3 commit or 1.2 + DOWNGRD check), never by unauthenticated HVR alone.
   */
  private dualPhase: DualPhase = "none";

  /**
   * @internal Dual association phase for tests and diagnostics.
   * Not part of the stable Public API (typedoc `--excludeInternal`).
   */
  get dualAssociationPhase(): DualAssociationPhase {
    return this.dualPhase;
  }

  /**
   * @deprecated Use dualAssociationPhase === "probing". Kept for internal/tests
   * that still read dualCookiePath via casting.
   */
  private get dualCookiePath(): boolean {
    return this.dualPhase === "probing";
  }

  /**
   * Original dual ClientHello + ECDHE material for 1.3 resume / retransmit.
   * Cleared when committed to 1.2 or 1.3.
   */
  private dualResume?: DualResumeClientHello;

  /**
   * Parked 1.3 engine after HVR: keeps CH-A retransmit (RFC 9147) while the
   * association probes the 1.2 cookie path.
   */
  private parkedEngine13?: Dtls13Connection;

  /**
   * Handshake carrier used by the dual association (default engine carrier or
   * injected). Kept after soft 1.3 dispose so commit12 can rebind inject to
   * the association 1.2 path without holding a dead engine reference.
   */
  private associationCarrier?: import("./carrier/types").DtlsHandshakeCarrier;

  /**
   * Peer pin snapshot for dual probing (from parked 1.3 engine at HVR).
   * Version commit (1.3 SH/HRR or 1.2 SH) requires matching source address.
   * Also owns the 1.2 TX destination so spoofed packets cannot hijack rinfo.
   */
  private dualAssociationPeerKey?: string;
  private dualAssociationPeerAddr?: [string, number];

  /**
   * Association generation token. Bumped on hard-close and on commit to 1.3
   * so in-flight async 1.2 handshake work (waitForReady / Flight5) cannot
   * resume after the association or version decision has moved on.
   */
  private associationGen = 0;

  /** Public constructor — accepts stable {@link Options} only. */
  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    const dual =
      supportsVersion(versions, DtlsVersion.V1_3) &&
      supportsVersion(versions, DtlsVersion.V1_2);
    // normalizeProtocolVersions maps [1.2,1.3] → [1.3,1.2]; dual always 1.3-first.
    const prefer13 = versions[0] === DtlsVersion.V1_3;

    // Pure 1.3 or dual [1.3,1.2]: start 1.3 engine; CH advertises full list.
    if (only13 || (dual && prefer13)) {
      this.startEngine13(only13, versions);
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
        this.dualPhase === "none" &&
        e instanceof DtlsVersionSelected &&
        e.version === DtlsVersion.V1_2,
    });

    if (dualCanContinue12) {
      engine.onError.subscribe((e) => {
        if (this.dualPhase !== "none") return;
        if (
          !(e instanceof DtlsVersionSelected) ||
          e.version !== DtlsVersion.V1_2
        ) {
          return;
        }
        log(
          "dual association: HVR → probing (1.3 CH-A park + 1.2 cookie path)",
          e.message,
        );
        // Engine already parked via tryParkDualProbe (CH-A retransmit kept).
        this.dualResume = engine.exportDualResumeClientHello();
        this.parkedEngine13 = engine;
        this.engine13 = undefined;
        this.dualPhase = "probing";
        this.connected = false;
        // Snapshot peer pin for association demux + 1.2 TX destination.
        this.pinAssociationPeer(
          engine.getPeerAddr(),
          engine.getExpectedPeerKey(),
        );
        // Association owns RX demux: both UDP onData and carrier.inject.
        // Leaving inject bound to the parked engine would let Epic 2 SPED
        // complete 1.3 while public engine13 stays undefined.
        this.bindAssociationInbound(engine);
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
        void this.continueDualAfterHvr(e.helloVerifyCookie).catch((err) => {
          // Cookie-path failure while still probing with a live parked 1.3:
          // stop 1.2 retransmit only — do not public-fail the association
          // (CH-A RTO may still complete 1.3). If no 1.3 candidate remains,
          // fail the whole association (no onError-only zombie state).
          if (this.dualPhase === "closed" || this.associationTornDown) return;
          const e = err instanceof Error ? err : new Error(String(err));
          if (
            this.dualPhase === "probing" &&
            this.parkedEngine13 &&
            !this.parkedEngine13.isClosed()
          ) {
            log(
              "dual cookie path failed while parked 1.3 live — abort 1.2 flight only",
              e.message,
            );
            this.abortLegacy12Flight(e);
            return;
          }
          this.reportLegacy12Fatal(e);
        });
      });
    }

    // Engine constructor binds transport.onData / carrier.inject to itself.
    // Association must own both immediately (pure 1.3 and dual initial) so
    // terminal/peer gates and carrier.inject never bypass udpOnMessage.
    this.bindAssociationInbound(engine);
  }

  /**
   * Hard-close every DTLS 1.3 candidate owned by this association (active
   * engine13 and/or parked dual probe). Cancels RTO timers and pending flights.
   * Bridge subscriptions are cut first so teardown onClose/onError cannot
   * leak to the public socket after association close.
   *
   * Does **not** clear or close {@link associationCarrier} — callers that hard-
   * close the association must call {@link closeAssociationCarrier} so that
   * commit12 soft-dispose (engine gone, carrier still open) cannot leak.
   *
   * @returns true when at least one engine was asked to graceful-close (may
   *   still be sending close_notify asynchronously — do not close transport yet).
   */
  private closeAllDtls13Candidates(opts?: {
    hardDispose?: boolean;
  }): boolean {
    this.unbridgeEngine13();
    const candidates = new Set<Dtls13Connection>();
    if (this.engine13) candidates.add(this.engine13);
    if (this.parkedEngine13) candidates.add(this.parkedEngine13);
    this.engine13 = undefined;
    this.parkedEngine13 = undefined;
    this.dualResume = undefined;
    this.dualAssociationPeerKey = undefined;
    this.dualAssociationPeerAddr = undefined;
    this.transport.pinnedPeer = undefined;
    let deferredTransportClose = false;
    for (const eng of candidates) {
      if (opts?.hardDispose) {
        // Fatal path: force carrier/timer stop even after soft ProtocolVersionError
        // (isClosed already true but carrier may still be open).
        eng.hardDisposeResources();
      } else if (!eng.isClosed()) {
        // Graceful: may async-send close_notify then teardownAssociation
        // (closes transport). Caller must not close transport synchronously.
        eng.close();
        deferredTransportClose = true;
      }
    }
    return deferredTransportClose;
  }

  /**
   * Hard-close the association-owned handshake carrier if still open.
   * Required after commit12: soft 1.3 dispose deliberately leaves the carrier
   * reusable until association hard-close.
   */
  private closeAssociationCarrier(): void {
    const carrier = this.associationCarrier;
    this.associationCarrier = undefined;
    if (carrier && !carrier.isClosed()) {
      carrier.close();
    }
  }

  /**
   * Full association hard-close: 1.2 flight stop, all 1.3 candidates, carrier,
   * timers, phase → closed, RX drop.
   *
   * Transport close policy:
   * - **Fatal** (`hardDisposeCandidates`): always close transport immediately
   *   (hardDispose does not close the UDP socket).
   * - **Graceful** local close: if an engine is still sending close_notify,
   *   defer transport close to engine `teardownAssociation` so notify is not
   *   dropped. When no live 1.3 candidate remains, close transport here.
   *
   * Public onClose ownership:
   * - **Local close** (`firePublicOnClose`): association fires onClose once
   *   (bridge is unsubscribed before eng.close, so engine teardown cannot).
   * - **Fatal**: caller (`bridgeEngine13` onError) fires onClose after this.
   * - **Peer close**: caller already fired onClose before this hook.
   */
  private closeAssociationHard(opts?: {
    hardDisposeCandidates?: boolean;
    /** Local close only — fire public onClose once while engine13 still visible. */
    firePublicOnClose?: boolean;
  }): void {
    // dualPhase already closed: never re-fire onClose.
    // - Peer/fatal finish path: hardDisposeCandidates + candidates still present
    // - Re-entrant local close() from onClose handlers: pure no-op (outer continues)
    if (this.dualPhase === "closed") {
      if (
        opts?.hardDisposeCandidates &&
        (this.engine13 || this.parkedEngine13)
      ) {
        this.closeAllDtls13Candidates({ hardDispose: true });
        this.closeAssociationCarrier();
        this.transport.socket.onData = this.udpOnMessage;
        void this.transport.socket.close().catch(() => {});
      } else if (!this.engine13 && !this.parkedEngine13) {
        this.closeAssociationCarrier();
        void this.transport.socket.close().catch(() => {});
      }
      return;
    }
    // Cancel cancelable 1.2 retransmit sleeps (not just flight=99 sentinel).
    this.abortLegacy12Flight();
    this.connected = false;
    this.associationTornDown = true;
    // Cancel waitForReady association sleeps immediately.
    this.abortAssociationWaits();
    // Mark closed before onClose so re-entrant client.close() is a no-op
    // (handlers that call close() inside onClose must not recurse).
    this.dualPhase = "closed";
    // Invalidate any in-flight 1.2 handshake / dual cookie async work.
    this.associationGen++;
    this.flight5 = undefined;
    // Local close: fire onClose while engine13 still visible (peer path parity).
    // Fatal/peer paths omit this flag — they already fire or will fire elsewhere.
    if (opts?.firePublicOnClose) {
      this.onClose.execute();
    }
    const deferredTransport = this.closeAllDtls13Candidates({
      hardDispose: opts?.hardDisposeCandidates,
    });
    // Always close association carrier (survives soft commit12 release).
    // close_notify uses transport.send, not the handshake carrier.
    this.closeAssociationCarrier();
    // Association demux stays closed-gated so late inject is a no-op.
    this.transport.socket.onData = this.udpOnMessage;
    if (opts?.hardDisposeCandidates || !deferredTransport) {
      // Fatal path, or no engine left to finish close_notify + teardown.
      void this.transport.socket.close().catch(() => {});
    }
    // Graceful with live engine: teardownAssociation closes transport after notify.
  }

  /**
   * Dual association fatal teardown: phase → closed, all candidates + 1.2 flight
   * stopped, RX drops further inject. Invoked from bridge on non-soft 1.3 errors
   * (committed13 fatal alert, 1.3-only version mismatch, RTO exhaust, …).
   * HVR soft (DtlsVersionSelected) never reaches here (filterError).
   * Public onClose is fired by bridge after this returns (not here).
   */
  protected failAssociationFromEngine13(err: Error): boolean {
    log("dual association: fatal teardown", err.message);
    this.closeAssociationHard({ hardDisposeCandidates: true });
    return true;
  }

  /**
   * DTLS 1.2 fatal alert / protocol_version on dual association (incl. committed12).
   * Same ownership as 1.3 fatal: phase closed, carrier/transport down, Public API off.
   * Caller fires onError then onClose when this returns true.
   */
  protected failLegacy12Association(error: Error): boolean {
    if (this.dualPhase === "closed" || this.associationTornDown) return false;
    log("dual association: 1.2 fatal teardown", error.message);
    // Preserve fatalError for Flight loops; hard-close owns phase/carrier/transport.
    this.abortLegacy12Flight(error);
    this.closeAssociationHard({ hardDisposeCandidates: true });
    return true;
  }

  /**
   * Peer close_notify on DTLS 1.2 path (committed12 / pure dual 1.2):
   * sync Public-API terminal (associationTornDown), best-effort reply with
   * send budget, then hard-close which flips dualPhase=closed + onClose once.
   * Do not set dualPhase=closed before hard-close or firePublicOnClose is skipped.
   */
  protected onLegacy12PeerCloseNotify(): void {
    if (this.dualPhase === "closed" || this.associationTornDown) return;
    log("dual association: 1.2 peer close_notify");
    // Sync Public API off immediately (send/exporter) while reply is in flight.
    this.abortLegacy12Flight();
    this.connected = false;
    this.associationTornDown = true;
    this.abortAssociationWaits();
    this.associationGen++;
    this.flight5 = undefined;
    // Budget-bound reply then hard-close (sets dualPhase closed + onClose).
    const notify = this.sendLegacy12CloseNotify().catch(() => {});
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.closeAssociationHard({
        firePublicOnClose: true,
        hardDisposeCandidates: true,
      });
    };
    const timer = globalThis.setTimeout(finish, 250);
    void notify.finally(() => {
      globalThis.clearTimeout(timer);
      finish();
    });
  }

  /**
   * Peer/engine onClose: mark dualPhase closed before public onClose so
   * re-entrant local close() inside handlers is idempotent (no second onClose).
   */
  protected prepareAssociationClosedFromEngine(): void {
    this.connected = false;
    this.associationTornDown = true;
    this.abortLegacy12Flight();
    this.abortAssociationWaits();
    // Base parity: drop TX pin on terminal (hard-close also clears).
    this.clearSendPeerPin();
    this.dualPhase = "closed";
    this.associationGen++;
    this.flight5 = undefined;
  }

  /**
   * Own association peer key + address for demux and 1.2 TX pin.
   * Sets TransportContext.pinnedPeer so Flight/app send ignore hijacked rinfo.
   */
  private pinAssociationPeer(addr?: [string, number], key?: string): void {
    if (addr) {
      // replace: dual association / client connect must own TX destination
      // even if a stale pin existed from a prior incomplete probe.
      this.pinSendPeer(addr, "replace");
      this.dualAssociationPeerAddr = this.transport.pinnedPeer
        ? [this.transport.pinnedPeer[0], this.transport.pinnedPeer[1]]
        : undefined;
      this.dualAssociationPeerKey =
        key ??
        peerKeyFromAddr(
          this.dualAssociationPeerAddr
            ? ([
                this.dualAssociationPeerAddr[0],
                this.dualAssociationPeerAddr[1],
              ] as [string, number])
            : undefined,
        );
    } else if (key) {
      this.dualAssociationPeerKey = key;
    }
  }

  /**
   * True when a captured associationGen still owns the DTLS 1.2 handshake path.
   * False after hard-close or commit to 1.3 (1.2 Flight5 must not resume).
   */
  private isLegacy12PathActive(gen: number): boolean {
    if (gen !== this.associationGen) return false;
    if (this.dualPhase === "closed") return false;
    if (this.dualPhase === "committed13") return false;
    if (this.engine13) return false;
    return true;
  }

  /**
   * True when dual cookie-path work after HVR may still send / throw publicly.
   */
  private isDualCookiePathActive(gen: number): boolean {
    return (
      gen === this.associationGen &&
      this.dualPhase === "probing" &&
      !this.engine13
    );
  }

  /**
   * Peer close_notify / engine onClose: full association closed (phase, carrier,
   * transport, public API guards). Called after public onClose so handlers can
   * still inspect engine13, then hard-closes association ownership.
   * Does not re-fire onClose (already delivered by bridge; dualPhase already closed).
   */
  protected onEngine13PeerOrLocalClose(): void {
    log("dual association: engine closed → association hard-close");
    // dualPhase already "closed" via prepareAssociationClosedFromEngine.
    this.closeAssociationHard({ hardDisposeCandidates: true });
  }

  /**
   * Public close: tear down all dual candidates, association carrier, and
   * 1.2 flight timers. Phase becomes permanently `closed`.
   * Fires public onClose once (bridge is disposed before eng.close).
   */
  close() {
    this.closeAssociationHard({ firePublicOnClose: true });
  }

  /**
   * Reject Public data / re-connect APIs while dual is probing or after hard close.
   * Active committed12 / committed13 / pure 1.2 (none) are allowed.
   */
  protected assertReadyForApplicationApi(op: string): void {
    if (this.dualPhase === "closed" || this.associationTornDown) {
      throw new Error(`DTLS association is closed; cannot ${op}`);
    }
    if (this.dualPhase === "probing") {
      throw new Error(
        `DTLS dual probing in progress; cannot ${op} until version is committed`,
      );
    }
  }

  /**
   * Point both UDP onData and carrier inject at the association dispatcher.
   * Used on dual probing entry, after commit12 soft-dispose of 1.3, and after
   * commit13 so carrier.inject never becomes a no-op or engine-only path that
   * bypasses closed/committed guards.
   */
  private bindAssociationInbound(engineWithCarrier?: Dtls13Connection): void {
    this.transport.socket.onData = this.udpOnMessage;
    if (engineWithCarrier) {
      this.associationCarrier = engineWithCarrier.getHandshakeCarrier();
    } else if (!this.associationCarrier) {
      this.associationCarrier =
        this.engine13?.getHandshakeCarrier() ??
        this.parkedEngine13?.getHandshakeCarrier();
    }
    const carrier = this.associationCarrier;
    if (carrier && !carrier.isClosed()) {
      carrier.setInjectHandler((bytes, peer) =>
        this.associationInject(bytes, peer),
      );
    }
  }

  /**
   * carrier.inject / dual demux entry: same path as UDP onData so 1.3 SH/HRR
   * commits via association (restores engine13) rather than a silent park complete.
   *
   * When `peer` is omitted, address is filled from `transport.rinfo` (then
   * association pin) before the peer gate — so inject of association-path
   * datagrams without an explicit peer still matches the pin.
   */
  private associationInject(
    bytes: Buffer,
    peer?: [string, number] | { address?: string; port?: number } | string,
  ): void {
    if (this.dualPhase === "closed") return;
    // Parse peer first; do NOT write transport.rinfo until peer gate accepts
    // (otherwise spoofed inject redirects 1.2 Flight / app send via rinfo).
    let addr: Address | undefined;
    if (peer != null) {
      if (Array.isArray(peer)) {
        addr = [peer[0], peer[1]];
      } else if (typeof peer === "string") {
        const i = peer.lastIndexOf(":");
        if (i > 0) {
          addr = [peer.slice(0, i), Number(peer.slice(i + 1))];
        }
      } else if (peer.address != null && peer.port != null) {
        addr = [peer.address, peer.port];
      }
    }
    // Peer omitted: fill from last rinfo, then association pin (TX ownership).
    if (!addr) {
      const t = this.options.transport as {
        rinfo?: { address?: string; port?: number };
      };
      if (t.rinfo?.address != null && t.rinfo?.port != null) {
        addr = [t.rinfo.address, t.rinfo.port];
      } else if (this.dualAssociationPeerAddr) {
        addr = [
          this.dualAssociationPeerAddr[0],
          this.dualAssociationPeerAddr[1],
        ];
      } else if (this.transport.pinnedPeer) {
        addr = [this.transport.pinnedPeer[0], this.transport.pinnedPeer[1]];
      }
    }
    // Peer gate before mutating shared transport.rinfo (all phases with a pin:
    // pure/none, probing, committed12/13). isAssociationPeer is true when unpinned.
    if (!this.isAssociationPeer(addr)) {
      log(
        "dual association: inject drop non-association peer (rinfo unchanged)",
        peerKeyFromAddr(
          addr ? ([addr[0], addr[1]] as [string, number]) : undefined,
        ),
      );
      return;
    }
    if (addr) {
      const t = this.options.transport as {
        rinfo?: { address?: string; port?: number };
      };
      t.rinfo = { address: addr[0], port: addr[1] };
    }
    this.udpOnMessage(Buffer.from(bytes), addr);
  }

  /**
   * True when inbound source matches dual association peer pin (or no pin yet).
   * Drops spoofed SH/HRR/alerts before version commit stops the other candidate.
   */
  private isAssociationPeer(addr?: Address): boolean {
    const peer = addr ? ([addr[0], addr[1]] as [string, number]) : undefined;
    const candidate = this.engine13 ?? this.parkedEngine13;
    if (candidate) {
      return candidate.matchesAssociationPeer(peer);
    }
    const expected = this.dualAssociationPeerKey;
    if (!expected) return true;
    const key = peerKeyFromAddr(peer);
    if (!key || key === "unknown") return false;
    return key === expected;
  }

  /** Commit dual probe to DTLS 1.2: stop 1.3 candidate and alert suppression. */
  private commitDualTo12(): void {
    if (
      this.dualPhase === "committed12" ||
      this.dualPhase === "committed13" ||
      this.dualPhase === "closed"
    ) {
      return;
    }
    log("dual association: commit DTLS 1.2");
    this.dualPhase = "committed12";
    this.dualResume = undefined;
    // Soft-dispose parked 1.3 (stops RTO, detaches inject to no-op).
    // Do not hard-close the shared carrier — Epic 2 / tests reuse it.
    if (this.parkedEngine13) {
      // Remember carrier before soft dispose so inject can be rebound.
      this.associationCarrier = this.parkedEngine13.getHandshakeCarrier();
      // Drop bridge before soft close so stale engine events cannot fire.
      this.unbridgeEngine13();
      this.parkedEngine13.releaseForVersionFallback();
      this.parkedEngine13 = undefined;
    }
    // Reclaim carrier.inject → association 1.2 path (not the no-op left by
    // releaseForVersionFallback). UDP onData already points here from probing.
    this.bindAssociationInbound();
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
   * Aborts silently if the association closes or commits to 1.3 mid-flight.
   */
  private async continueDualAfterHvr(cookie?: Buffer) {
    const gen = this.associationGen;
    if (!this.isDualCookiePathActive(gen)) return;
    try {
      if (this.dualResume) {
        await this.resendDualClientHelloWithCookie(cookie, gen);
        return;
      }
      await this.sendDualNegotiationClientHello(cookie, gen);
    } catch (err) {
      // close / version commit during Flight1 — do not surface as public onError
      if (!this.isDualCookiePathActive(gen)) return;
      throw err;
    }
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
  private async resendDualClientHelloWithCookie(
    legacyCookie?: Buffer,
    gen = this.associationGen,
  ) {
    if (!this.isDualCookiePathActive(gen)) return;
    if (!this.dualResume) {
      throw new Error("dual resume ClientHello missing for HVR cookie path");
    }
    // Build cookie CH from original dualResume without mutating 1.3 resume material.
    const hello = ClientHello.deSerialize(this.dualResume.clientHelloBody);
    hello.cookie = legacyCookie ? Buffer.from(legacyCookie) : Buffer.from([]);
    // Clear messageSeq so Flight1 re-assigns seq 0 for this transmission
    hello.messageSeq = undefined as any;

    if (!this.isDualCookiePathActive(gen)) return;
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
  private async sendDualNegotiationClientHello(
    legacyCookie?: Buffer,
    gen = this.associationGen,
  ) {
    if (!this.isDualCookiePathActive(gen)) return;
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

    if (!this.isDualCookiePathActive(gen)) return;
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
    if (!this.isDualCookiePathActive(gen)) return;
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
      hello,
    );
  }

  /** 32-byte ServerHello.random for DOWNGRD checks. */
  private serverHelloRandom32(sh: ServerHello): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
    return Buffer.concat([b, sh.random.random_bytes]);
  }

  /**
   * During dual probing, classify a ServerHello body before version commit.
   * - dtls13: supported_versions selected 1.3 (and suite consistent)
   * - dtls12: fully parsed legitimate 1.2 SH (cipher, legacy version, optional SV)
   * - drop: malformed / inconsistent wire (keep parked 1.3, no commit)
   * - error: actionable protocol failure (e.g. unknown selected version)
   */
  private classifyProbingServerHello(fragment: Buffer):
    | { kind: "dtls13"; sh: ServerHello }
    | {
        kind: "dtls12";
        sh: ServerHello;
        hasDowngradeSentinel: boolean;
      }
    | { kind: "drop"; reason: string }
    | { kind: "error"; error: Error } {
    let sh: ServerHello;
    try {
      sh = ServerHello.deSerialize(fragment);
    } catch (e) {
      return {
        kind: "drop",
        reason: e instanceof Error ? e.message : "ServerHello parse failed",
      };
    }
    // Required fields must be present after deserialize
    if (
      !sh.serverVersion ||
      sh.cipherSuite == null ||
      sh.random?.random_bytes == null ||
      !Buffer.isBuffer(sh.sessionId)
    ) {
      return { kind: "drop", reason: "ServerHello incomplete fields" };
    }
    // Round-trip: reject trailing garbage / incomplete extension parse
    try {
      const round = sh.serialize();
      if (round.length !== fragment.length) {
        return {
          kind: "drop",
          reason: `ServerHello length mismatch serialize=${round.length} wire=${fragment.length}`,
        };
      }
    } catch (e) {
      return {
        kind: "drop",
        reason:
          e instanceof Error ? e.message : "ServerHello re-serialize failed",
      };
    }

    const legacyWire = wireVersionToNumber(sh.serverVersion);
    // DTLS ServerHello.legacy_version is DTLS 1.2 (0xfefd) for both 1.2 and 1.3
    if (legacyWire !== DTLS_1_2_VERSION) {
      return {
        kind: "drop",
        reason: `unexpected ServerHello.serverVersion 0x${legacyWire.toString(16)}`,
      };
    }

    const versionsExt = sh.extensions?.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (versionsExt) {
      let sv: SupportedVersions;
      try {
        sv = SupportedVersions.fromData(versionsExt.data, true);
      } catch (e) {
        return {
          kind: "drop",
          reason:
            e instanceof Error ? e.message : "supported_versions parse failed",
        };
      }
      if (sv.selected === DTLS_1_3_VERSION) {
        // 1.3 selection should use a 1.3 suite
        if (sh.cipherSuite === CipherSuite.TLS_AES_128_GCM_SHA256_0x1301) {
          return { kind: "dtls13", sh };
        }
        // Inconsistent: 1.3 selected with 1.2 suite — do not commit either way
        return {
          kind: "drop",
          reason: "supported_versions=1.3 but cipher suite is not TLS 1.3",
        };
      }
      if (sv.selected === DTLS_1_2_VERSION) {
        // fall through to 1.2 suite checks
      } else if (sv.selected != null) {
        return {
          kind: "error",
          error: new ProtocolVersionError(
            `unsupported ServerHello selected version 0x${sv.selected.toString(16)}`,
          ),
        };
      } else {
        return { kind: "drop", reason: "supported_versions missing selected" };
      }
    }

    // DTLS 1.2 path: reject TLS 1.3-only suite
    if (sh.cipherSuite === CipherSuite.TLS_AES_128_GCM_SHA256_0x1301) {
      return {
        kind: "drop",
        reason: "TLS 1.3 cipher suite without DTLS 1.3 selected version",
      };
    }
    // Known 1.2 suites we negotiate (reject unknown / garbage suite codes)
    const suite12ok =
      sh.cipherSuite ===
        CipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256_49195 ||
      sh.cipherSuite ===
        CipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256_49199;
    if (!suite12ok) {
      return {
        kind: "drop",
        reason: `unknown or unsupported DTLS 1.2 cipher suite 0x${Number(sh.cipherSuite).toString(16)}`,
      };
    }
    // Null compression only
    if (sh.compressionMethod !== 0) {
      return {
        kind: "drop",
        reason: `unsupported compression_method ${sh.compressionMethod}`,
      };
    }

    return {
      kind: "dtls12",
      sh,
      hasDowngradeSentinel: hasTlsDowngradeSentinel(
        this.serverHelloRandom32(sh),
      ),
    };
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
   * Dual path: ServerHello/HRR selected DTLS 1.3 — prefer unparking the parked
   * CH-A engine (keeps transcript continuity); else prime a fresh engine from
   * dualResume and reinject the datagram.
   */
  private resumeDtls13FromDualPath(datagram: Buffer): void {
    if (this.dualPhase === "closed" || this.dualPhase === "committed12") {
      // Late 1.3 after close or 1.2 commit must not reverse the association.
      return;
    }

    const rinfo = (
      this.options.transport as {
        rinfo?: { address?: string; port?: number };
      }
    ).rinfo;

    const parked = this.parkedEngine13;
    const material = this.dualResume;

    // No parked engine and no CH-A material: cannot complete 1.3 resume.
    // Tear down association (do not leave dualPhase=committed13 without engine).
    if ((!parked || parked.isClosed()) && !material) {
      this.reportLegacy12Fatal(
        new ProtocolVersionError(
          "dual path selected DTLS 1.3 but dual ClientHello material is missing",
        ),
      );
      return;
    }

    // Stop 1.2 Flight1 retransmit by advancing flight only — never set fatalError
    // for a successful version commit (would surface as delayed public onError).
    this.abortLegacy12Flight();
    this.dualPhase = "committed13";
    // Invalidate in-flight 1.2 handleHandshakes / Flight5 after version commit.
    this.associationGen++;
    this.flight5 = undefined;
    this.parkedEngine13 = undefined;
    this.dualResume = undefined;

    if (parked && !parked.isClosed()) {
      log(
        "dual association: ServerHello selected DTLS 1.3 — unpark parked engine",
      );
      parked.unparkFromDualProbe();
      // Events already bridged at startEngine13; re-own public engine13 handle.
      this.engine13 = parked;
      // Association keeps UDP + carrier.inject; engine RX only via injectDatagram.
      this.bindAssociationInbound(parked);
      parked.injectDatagram(datagram, rinfo);
      return;
    }

    // material is defined: early return when both parked and material missing.
    const resumeMaterial = material!;
    log(
      "dual association: ServerHello selected DTLS 1.3 — resume 1.3 engine from dualResume",
    );
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
    engine.primeFromSentClientHello(resumeMaterial);
    this.bridgeEngine13(engine);
    // Constructor stole transport.onData / inject — reclaim for association.
    this.bindAssociationInbound(engine);
    // Full datagram reinject so coalesced epoch-2 records are not lost
    engine.injectDatagram(datagram, rinfo);
  }

  async connect() {
    // Terminal / probing must not fall through to pure 1.2 Flight1 or re-HS.
    if (this.dualPhase === "closed" || this.associationTornDown) {
      throw new Error("DTLS association is closed; cannot connect");
    }
    if (this.dualPhase === "probing") {
      throw new Error(
        "DTLS dual probing in progress; connect() already started (wait for version commit)",
      );
    }
    // Pin 1.2 TX destination from configured rinfo before any flight retransmit.
    // replace: connect() is the client association start of truth for peer TX.
    this.pinSendPeerFromTransportRinfo("replace");
    this.pinAssociationPeer(
      this.transport.pinnedPeer
        ? [this.transport.pinnedPeer[0], this.transport.pinnedPeer[1]]
        : undefined,
    );
    if (this.engine13) {
      await this.engine13.connect();
      // After 1.3 connect pin, sync association pin for dual fallout.
      const eng = this.engine13;
      if (eng) {
        this.pinAssociationPeer(eng.getPeerAddr(), eng.getExpectedPeerKey());
      }
      return;
    }
    await this.connect12();
  }

  private async connect12() {
    this.pinSendPeerFromTransportRinfo("replace");
    this.pinAssociationPeer(
      this.transport.pinnedPeer
        ? [this.transport.pinnedPeer[0], this.transport.pinnedPeer[1]]
        : undefined,
    );
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
    );
  }

  private flight5?: Flight5;
  private handleHandshakes = async (
    assembled: FragmentedHandshake[],
    _peer?: Address,
  ) => {
    if (this.engine13) return;
    if (this.dualPhase === "closed") return;
    // Capture generation so awaits cannot resume after close / commit13.
    const gen = this.associationGen;

    log(
      this.dtls.sessionId,
      "handleHandshakes",
      assembled.map((a) => a.msg_type),
    );

    for (const handshake of assembled) {
      if (!this.isLegacy12PathActive(gen)) return;
      switch (handshake.msg_type) {
        case HandshakeType.hello_verify_request_3:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment,
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
            if (!this.isLegacy12PathActive(gen)) return;
            // Do not overwrite dualResume with the cookie-bearing CH2 body.
            // dualResume is the original dual CH-A used if a 1.3 SH/HRR for
            // that first CH still arrives (spoofed HVR race). Pure 1.2 peers
            // never select 1.3, so cookie CH is only needed on the 1.2 flights.
          }
          break;
        case HandshakeType.server_hello_2:
          {
            if (this.connected) return;
            if (!this.isLegacy12PathActive(gen)) return;
            const only13 =
              this.protocolVersions.length === 1 &&
              this.protocolVersions[0] === DtlsVersion.V1_3;
            if (only13) {
              // Hard version mismatch: tear down association (no parked RTO left).
              this.reportLegacy12Fatal(
                new ProtocolVersionError(
                  "DTLS 1.3-only client received non-1.3 ServerHello",
                ),
              );
              return;
            }

            // Dual probing: strict SH validation before version commit.
            // Malformed / unknown version must NOT commit12 (keeps 1.3 candidate).
            if (this.dualPhase === "probing") {
              const verdict = this.classifyProbingServerHello(
                handshake.fragment,
              );
              if (verdict.kind === "drop") {
                log(
                  "dual probing: discard invalid ServerHello (no version commit)",
                  verdict.reason,
                );
                return;
              }
              if (verdict.kind === "error") {
                // Actionable protocol failure (e.g. unknown selected version):
                // same association teardown as fatal alert / DOWNGRD.
                this.reportLegacy12Fatal(verdict.error);
                return;
              }
              if (verdict.kind === "dtls13") {
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
              // kind === "dtls12": DOWNGRD check then commit
              if (verdict.hasDowngradeSentinel) {
                // Client still offered 1.3 — illegal downgrade. Close association
                // so parked 1.3 RTO / carrier cannot outlive onError.
                this.reportLegacy12Fatal(
                  new ProtocolVersionError(
                    "illegal_parameter: ServerHello Random contains TLS downgrade sentinel while client offered DTLS 1.3",
                  ),
                );
                return;
              }
              if (!this.isLegacy12PathActive(gen)) return;
              this.commitDualTo12();
              if (!this.isLegacy12PathActive(gen)) return;
              this.flight5 = new Flight5(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp,
              );
              this.flight5.handleHandshake(handshake);
              break;
            }

            // Non-probing (pure 1.2 or already committed12): legacy path with
            // DOWNGRD when client still offered 1.3.
            if (supportsVersion(this.protocolVersions, DtlsVersion.V1_3)) {
              try {
                const sh = ServerHello.deSerialize(handshake.fragment);
                const random32 = this.serverHelloRandom32(sh);
                if (hasTlsDowngradeSentinel(random32)) {
                  this.reportLegacy12Fatal(
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
                  this.reportLegacy12Fatal(e as Error);
                  return;
                }
              }
            }

            if (!this.isLegacy12PathActive(gen)) return;
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
            // 解放済み candidate に触れないよう await 後に再検証
            if (!this.isLegacy12PathActive(gen)) return;
            this.flight5?.handleHandshake(handshake);
          }
          break;
        case HandshakeType.server_hello_done_14:
          {
            await this.waitForReady(() => !!this.flight5);
            if (!this.isLegacy12PathActive(gen)) return;
            this.flight5?.handleHandshake(handshake);

            const targets = [
              11,
              12,
              this.options.certificateRequest && 13,
            ].filter((n): n is number => typeof n === "number");
            await this.waitForReady(() =>
              this.dtls.checkHandshakesExist(targets),
            );
            // close / commit13 後は Flight5.exec も onConnect も行わない
            if (!this.isLegacy12PathActive(gen)) return;
            await this.flight5?.exec();
            if (!this.isLegacy12PathActive(gen)) return;
          }
          break;
        case HandshakeType.finished_20:
          {
            if (!this.isLegacy12PathActive(gen)) return;
            if (this.connected) return;
            this.dtls.flight = 7;
            this.connected = true;
            // Keep existing connect()-time pin; never replace from last rinfo
            // (spoof before Finished must not hijack app TX).
            this.pinSendPeerFromTransportRinfo("set-if-empty");
            // Flight5 was sleeping until nextFlight=7; cancel RTO sleep before
            // onConnect so pending timers/tasks are gone on handshake complete.
            this.cancelLegacy12FlightTimers();
            this.onConnect.execute();
            log(this.dtls.sessionId, "dtls connected");
          }
          break;
      }
    }
  };

  /**
   * Association inbound dispatcher (UDP onData and carrier.inject).
   *
   * - closed: drop everything (no reconnect, no timer restart)
   * - non-association peer: drop before version commit (anti-spoof)
   * - active engine13 (committed13 / pure 1.3 after dual resume): forward to 1.3
   * - probing + 1.3 SH/HRR from association peer: version commit to 1.3
   * - probing + epoch-0 illegal_parameter only: suppress (legacy_cookie vs 1.3)
   * - else: DTLS 1.2 record path (committed12 / dual cookie / pure 1.2)
   */
  protected udpOnMessage = (data: Buffer, addr?: Address) => {
    // Terminal: dualPhase closed *or* associationTornDown mid peer-close reply.
    if (this.dualPhase === "closed" || this.associationTornDown) {
      return;
    }
    // Prefer explicit addr (UDP / inject); fall back to last rinfo.
    const peerAddr =
      addr ??
      (() => {
        const r = (
          this.options.transport as {
            rinfo?: { address?: string; port?: number };
          }
        ).rinfo;
        if (r?.address != null && r?.port != null) {
          return [r.address, r.port] as Address;
        }
        return undefined;
      })();

    // Committed (or pure) 1.3: association still owns demux so late 1.2 / post-
    // close races cannot bypass closed/committed12 guards via engine-only RX.
    const peerTuple = peerAddr
      ? ([peerAddr[0], peerAddr[1]] as [string, number])
      : undefined;

    // Peer gate for every phase that has a pin (pure 1.3 after connect, dual
    // probing/committed). Unpinned pure/initial still accepts (engine/pre-HS).
    if (!this.isAssociationPeer(peerAddr)) {
      log(
        "dual association: drop datagram from non-association peer",
        peerKeyFromAddr(peerTuple),
        this.dualAssociationPeerKey,
      );
      this.restorePinnedRinfo();
      return;
    }

    if (this.engine13 && !this.engine13.isClosed()) {
      this.engine13.injectDatagram(data, peerTuple);
      return;
    }

    if (
      this.dualPhase === "probing" &&
      !this.engine13 &&
      this.datagramSelectsDtls13(data)
    ) {
      this.resumeDtls13FromDualPath(data);
      return;
    }
    if (
      this.dualPhase === "probing" &&
      !this.engine13 &&
      this.datagramIsEpoch0IllegalParameterAlert(data)
    ) {
      log(
        "dual probing: ignore epoch-0 illegal_parameter alert (likely legacy_cookie vs DTLS 1.3)",
      );
      return;
    }
    // After commit12, late 1.3 SH must not reverse version (resume guards too).
    // Pass peer so base 1.2 RX pin gate applies (UDP + carrier.inject parity).
    this.handleUdpDatagram(data, peerAddr);
  };

  /**
   * Epoch-0 fatal illegal_parameter (47) only — used while dual-probing to
   * ignore DTLS 1.3 servers rejecting a non-empty legacy_cookie ClientHello.
   * Must not swallow epoch≥1 or non-illegal_parameter actionable alerts.
   */
  private datagramIsEpoch0IllegalParameterAlert(data: Buffer): boolean {
    try {
      if (data.length < 15) return false;
      const contentType = data[0];
      if (contentType !== ContentType.alert) return false;
      // DTLSPlaintext: type(1) version(2) epoch(2) seq(6) length(2) body
      const epoch = data.readUInt16BE(3);
      if (epoch !== 0) return false;
      const contentLen = data.readUInt16BE(11);
      if (contentLen < 2 || 13 + contentLen > data.length) return false;
      const level = data[13];
      const description = data[14];
      return level >= 2 && description === AlertDesc.IllegalParameter;
    } catch {
      return false;
    }
  }
}
