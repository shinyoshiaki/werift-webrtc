import { randomBytes } from "crypto";
import { isIPv4 } from "net";

import * as timers from "node:timers/promises";
import { type Address, Event, debug } from "./imports/common";

import {
  Candidate,
  candidateFoundation,
  candidatePriority,
  remoteTcpTypeForIncoming,
} from "./candidate";
import { MdnsLookup } from "./dns/lookup";
import type { TransactionError } from "./exceptions";
import { type Cancelable, PQueue, cancelable, randomString } from "./helper";
import {
  CONSENT_INTERVAL,
  CONSENT_TIMEOUT,
  CandidatePair,
  CandidatePairState,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  consentResponseTimeoutMs,
  defaultOptions,
  serverReflexiveCandidate,
  sortCandidatePairs,
  validateAddress,
  validateRemoteCandidate,
} from "./iceBase";
import {
  connectionDatagramEvent,
  isAuthenticatedHandshakePair,
} from "./internal/datagram";
import {
  getConnectionSpedRuntime,
  registerSpedCarryMaybeFlush,
  setConnectionSpedRuntime,
} from "./internal/sped-bind";
import type { SpedRuntime } from "./sped/runtime";
import { RETRY_MAX, RETRY_RTO, classes, methods } from "./stun/const";
import { Message, parseMessage } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol } from "./types/model";
import { getHostAddresses } from "./utils";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

function isTcpLocalActivePair(pair: CandidatePair): boolean {
  return (
    pair.localCandidate.transport.toLowerCase() === "tcp" &&
    pair.localCandidate.tcptype === "active"
  );
}

function isTcpLocalPassivePair(pair: CandidatePair): boolean {
  return (
    pair.localCandidate.transport.toLowerCase() === "tcp" &&
    pair.localCandidate.tcptype === "passive"
  );
}

function isTcpActiveCandidate(candidate: {
  transport: string;
  tcptype?: string;
}): boolean {
  return (
    candidate.transport.toLowerCase() === "tcp" &&
    candidate.tcptype === "active"
  );
}

/**
 * One STUN connectivity-check transaction: initial send plus RETRY_MAX
 * retransmissions with doubling RTO. Used as the inbound TCP pair wait so
 * ICE does not hang on a passive listener after known pairs are exhausted.
 */
function stunTransactionLifetimeMs() {
  const tries = 1 + RETRY_MAX;
  return RETRY_RTO * (2 ** tries - 1);
}

/** Fallback STUN server when none is configured (constructor / setIceServers). */
const DEFAULT_STUN_SERVER: Address = ["stun.l.google.com", 19302];

export class Connection implements IceConnection {
  localUsername = randomString(4);
  localPassword = randomString(22);
  remoteIsLite = false;
  remotePassword: string = "";
  remoteUsername: string = "";
  checkList: CandidatePair[] = [];
  localCandidates: Candidate[] = [];
  stunServer?: Address;
  turnServer?: Address;
  options: IceOptions;
  remoteCandidatesEnd = false;
  localCandidatesEnd = false;
  generation = -1;
  userHistory: { [username: string]: string } = {};
  private readonly tieBreaker: bigint = randomBytes(8).readBigUInt64BE(0);
  state: IceState = "new";
  lookup?: MdnsLookup;

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  nominated?: CandidatePair;
  private nominating = false;
  private checkListDone = false;
  private checkListState = new PQueue<number>();
  private incomingTcpPairWait?: { settle: (learned: boolean) => void };
  private earlyChecks: [Message, Address, Protocol][] = [];
  private earlyChecksDone = false;
  private localCandidatesStart = false;
  private protocols: Protocol[] = [];
  private queryConsentHandle?: Cancelable<void>;
  /** RFC 7675 consent-to-send: application data may use the selected pair. */
  private consentFresh = false;
  /** Invalidates in-flight consent callbacks on restart / close / replace / expire. */
  private consentSessionId = 0;
  private consentExpiryTimer?: ReturnType<typeof setTimeout>;
  private consentRequestAbort?: AbortController;

  readonly onData = new Event<[Buffer]>();
  readonly stateChanged = new Event<[IceState]>();
  readonly onIceCandidate: Event<[Candidate]> = new Event();

  /** @internal SPED controller; unset unless PeerConfig.sped (or tests) attach it. */
  private get spedRuntime(): SpedRuntime | undefined {
    return getConnectionSpedRuntime(this);
  }
  private set spedRuntime(runtime: SpedRuntime | undefined) {
    setConnectionSpedRuntime(this, runtime);
  }
  private spedCarryInFlight = false;
  private spedCarryQueued = false;
  /**
   * After receiving SPED DATA, send one more Binding even without local L1
   * so ICE-Lite (Responses only) can put the next L1 datagram on the reply.
   */
  private spedSolicitPeerCarry = false;
  private spedCarryEpoch = 0;
  private spedIncomingStunDepth = 0;

  constructor(
    private _iceControlling: boolean,
    options?: Partial<IceOptions>,
  ) {
    this.options = {
      ...defaultOptions,
      ...options,
    };
    if (this.iceLite) {
      this._iceControlling = false;
    }
    this.applyStunTurnServersFromOptions();
    registerSpedCarryMaybeFlush(this, () => this.maybeFlushSpedCarry());
    this.restart();
    log("new Connection", this.options);
  }

  /**
   * Replace STUN/TURN servers after construction.
   * Server-related fields are replaced (not partial-merged) so that removing
   * TURN clears residual credentials. W3C setConfiguration replaces the ICE
   * server list rather than merging additively.
   *
   * Used when servers are learned after the gatherer was built (e.g. WHIP
   * Link headers) and must take effect before the next gather pass.
   */
  setIceServers(options: Partial<IceOptions>) {
    // Explicitly assign server fields even when undefined so a STUN-only
    // update cannot leave a previous TURN host/credential in options.
    this.options = {
      ...this.options,
      stunServer: options.stunServer,
      turnServer: options.turnServer,
      turnUsername: options.turnUsername,
      turnPassword: options.turnPassword,
      turnTransport: options.turnTransport,
    };
    if (options.forceTurn !== undefined) {
      this.options.forceTurn = options.forceTurn;
    }
    if (options.useTcp !== undefined) {
      this.options.useTcp = options.useTcp;
    }
    if (options.turnTlsOptions !== undefined) {
      this.options.turnTlsOptions = options.turnTlsOptions;
    }

    this.applyStunTurnServersFromOptions();
    log("Connection ice servers updated", this.options);
  }

  /**
   * Derive Connection.stunServer / turnServer from this.options.
   * Shared by the constructor and setIceServers so both paths validate and
   * default identically.
   */
  private applyStunTurnServersFromOptions() {
    this.stunServer =
      validateAddress(this.options.stunServer) ?? DEFAULT_STUN_SERVER;
    this.turnServer = validateAddress(this.options.turnServer);
  }

  get iceControlling() {
    return this._iceControlling;
  }

  set iceControlling(value: boolean) {
    if (this.iceLite) {
      value = false;
    }
    // While a pair is selected, keep the negotiated role. ICE restart clears
    // `nominated`, so offer/answer role and RFC 8445 role-conflict repair can
    // reassign controlling/controlled for the new generation.
    if (this.nominated) {
      return;
    }
    this.applyIceControlling(value);
  }

  get iceLite() {
    return this.options.iceLite;
  }

  async restart() {
    this.generation++;
    this.spedCarryEpoch++;
    this.abandonInFlightStunTransactions();

    this.localUsername = randomString(4);
    this.localPassword = randomString(22);
    if (this.options.localPasswordPrefix) {
      this.localPassword =
        this.options.localPasswordPrefix +
        this.localPassword.slice(this.options.localPasswordPrefix.length);
    }
    this.userHistory[this.localUsername] = this.localPassword;

    this.remoteUsername = "";
    this.remotePassword = "";
    this.localCandidates = [];
    this._remoteCandidates = [];
    this.remoteCandidatesEnd = false;
    this.localCandidatesEnd = false;
    this.state = "new";
    this.lookup?.close?.();
    this.lookup = undefined;
    this.nominated = undefined;
    this.nominating = false;
    this.checkList = [];
    this.checkListDone = false;
    this.cancelIncomingTcpPairWait();
    this.checkListState = new PQueue<number>();
    this.earlyChecks = [];
    this.earlyChecksDone = false;
    this.localCandidatesStart = false;

    // protocolsはincomingのearlyCheckに使うかもしれないので残す
    for (const protocol of this.protocols) {
      if (protocol.localCandidate) {
        protocol.localCandidate.refreshId();
        protocol.localCandidate.generation = this.generation;
        protocol.localCandidate.ufrag = this.localUsername;
      }
    }

    // Tear down consent timers/transactions; new credentials require a new session.
    this.stopConsentLifecycle();
    this.spedCarryInFlight = false;
    this.spedCarryQueued = false;
    this.spedSolicitPeerCarry = false;
    this.spedRuntime?.reset(this.generation);
  }

  /** DTLS handshake datagram on an authenticated current-generation pair. */
  private async sendHandshakeOnAuthenticatedPair(
    pair: CandidatePair,
    bytes: Buffer,
    generation: number,
  ) {
    if (generation !== this.generation) {
      return;
    }
    if (!isAuthenticatedHandshakePair(pair)) {
      return;
    }
    this.spedRuntime?.pinHandshakePath(pair);
    await pair.protocol.sendData(bytes, pair.remoteAddr);
  }

  /**
   * Direct fallback only on a current-generation authenticated CandidatePair.
   * No pair (e.g. earlyChecks) means no wire send.
   */
  private async maybeSendSpedFallback(
    protocol: Protocol,
    addr: Address,
    generation: number,
  ) {
    const runtime = this.spedRuntime;
    if (!runtime || generation !== this.generation) {
      return;
    }
    if (runtime.fallbackStarted || runtime.session.state !== "fallback") {
      return;
    }
    const pair = this.findPairByAddr(protocol, addr);
    if (!pair || !isAuthenticatedHandshakePair(pair)) {
      return;
    }
    runtime.pinHandshakePath(pair);
    const packets = runtime.beginFallback();
    await runtime.hooks.onFallbackFlight(packets);
    for (const packet of packets) {
      await this.sendHandshakeOnAuthenticatedPair(pair, packet, generation);
    }
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.nominating = false;
    // Drop old pair's consent timers/transactions; restarted when a new pair is nominated.
    this.stopConsentLifecycle();
  }

  setRemoteParams({
    iceLite,
    usernameFragment,
    password,
  }: {
    iceLite: boolean;
    usernameFragment: string;
    password: string;
  }) {
    log("setRemoteParams", { iceLite, usernameFragment, password });
    this.remoteIsLite = iceLite;
    this.remoteUsername = usernameFragment;
    this.remotePassword = password;
    this.spedRuntime?.syncPathMtuFromConnection(this);
  }

  // 4.1.1 Gathering Candidates
  async gatherCandidates() {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;

      // ICE restart keeps transport protocols; re-advertise their host candidates
      // with the new generation / ufrag before gathering additional addresses.
      for (const protocol of this.protocols) {
        if (protocol.localCandidate) {
          protocol.localCandidate.generation = this.generation;
          protocol.localCandidate.ufrag = this.localUsername;
          this.appendLocalCandidate(protocol.localCandidate);
        }
      }

      let address = getHostAddresses(
        this.options.useIpv4,
        this.options.useIpv6,
        {
          useLinkLocalAddress: this.options.useLinkLocalAddress,
        },
      );
      const { interfaceAddresses } = this.options;
      if (interfaceAddresses) {
        const filteredAddresses = address.filter((check) =>
          Object.values(interfaceAddresses).includes(check),
        );
        if (filteredAddresses.length) {
          address = filteredAddresses;
        }
      }
      if (this.options.additionalHostAddresses) {
        address = Array.from(
          new Set([...this.options.additionalHostAddresses, ...address]),
        );
      }

      const candidatePromises = this.getCandidatePromises(
        address,
        this.options.stunGatherTimeout,
      );
      await Promise.allSettled(candidatePromises);

      this.localCandidatesEnd = true;
    }
    this.setState("completed");
  }

  private appendLocalCandidate(candidate: Candidate) {
    this.localCandidates.push(candidate);
    this.onIceCandidate.execute(candidate);
  }

  private ensureProtocol(protocol: Protocol) {
    protocol.onRequestReceived.subscribe((msg, addr, data) => {
      void this.handleBindingRequest(protocol, msg, addr, data);
    });
    protocol.onDataReceived.subscribe((data, addr) => {
      try {
        const pair = this.resolveDatagramPair(protocol, addr);
        const authenticated = !!(pair && isAuthenticatedHandshakePair(pair));
        connectionDatagramEvent(this).execute({
          bytes: data,
          source: addr ?? pair?.remoteAddr ?? ["0.0.0.0", 0],
          protocol,
          pair,
          generation: this.generation,
          authenticated,
        });

        const activePair = this.nominated;
        if (activePair && activePair.protocol === protocol) {
          activePair.packetsReceived++;
          activePair.bytesReceived += data.length;
        }

        this.onData.execute(data);
      } catch (error) {
        log("dataReceived", error);
      }
    });
  }

  private async handleBindingRequest(
    protocol: Protocol,
    msg: Message,
    addr: Address,
    data: Buffer,
  ) {
    if (msg.messageMethod !== methods.BINDING) {
      this.respondError(msg, addr, protocol, [400, "Bad Request"]);
      return;
    }

    const txUsername = msg.getAttributeValue("USERNAME");
    if (typeof txUsername !== "string" || !txUsername.includes(":")) {
      return;
    }
    const { remoteUsername: localUsername } = decodeTxUsername(txUsername);
    const localPassword = this.userHistory[localUsername] ?? this.localPassword;

    const verified = parseMessage(data, Buffer.from(localPassword, "utf8"));
    if (!verified) {
      log("drop unauthenticated Binding Request");
      return;
    }

    const isCurrentGeneration = localUsername === this.localUsername;

    if (!isCurrentGeneration) {
      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        verified.transactionId,
      );
      response
        .setAttribute("XOR-MAPPED-ADDRESS", addr)
        .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
        .addFingerprint();
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });
      return;
    }

    const { iceControlling } = this;
    this.spedIncomingStunDepth++;
    try {
      await this.handleCurrentGenerationBinding(
        protocol,
        verified,
        addr,
        localPassword,
        iceControlling,
      );
    } finally {
      this.spedIncomingStunDepth--;
      if (this.spedIncomingStunDepth === 0 && this.spedCarryQueued) {
        this.spedCarryQueued = false;
        void this.flushSpedCarry();
      }
    }
  }

  private async handleCurrentGenerationBinding(
    protocol: Protocol,
    verified: Message,
    addr: Address,
    localPassword: string,
    iceControlling: boolean,
  ) {
    // 7.2.1.1.  Detecting and Repairing Role Conflicts
    if (iceControlling && verified.attributesKeys.includes("ICE-CONTROLLING")) {
      if (this.tieBreaker >= verified.getAttributeValue("ICE-CONTROLLING")) {
        this.respondError(verified, addr, protocol, [487, "Role Conflict"]);
        return;
      } else {
        this.switchRole(false);
      }
    } else if (
      !iceControlling &&
      verified.attributesKeys.includes("ICE-CONTROLLED")
    ) {
      if (
        this.iceLite ||
        this.tieBreaker < verified.getAttributeValue("ICE-CONTROLLED")
      ) {
        this.respondError(verified, addr, protocol, [487, "Role Conflict"]);
        return;
      } else {
        this.switchRole(true);
        return;
      }
    }

    if (
      this.options.filterStunResponse &&
      !this.options.filterStunResponse(verified, addr, protocol)
    ) {
      return;
    }

    const generation = this.generation;
    if (
      this.spedRuntime?.shouldDecorate(protocol) &&
      this.spedRuntime.isLiveGeneration(generation)
    ) {
      await this.spedRuntime.handleAuthenticatedStun(
        verified,
        addr,
        generation,
        protocol,
      );
      if (generation !== this.generation) {
        return;
      }
    }

    const response = new Message(
      methods.BINDING,
      classes.RESPONSE,
      verified.transactionId,
    );
    response.setAttribute("XOR-MAPPED-ADDRESS", addr);
    if (this.spedRuntime?.shouldDecorate(protocol)) {
      if (!this.spedRuntime.decorateOutgoing(response, protocol)) {
        return;
      }
    }
    response
      .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
      .addFingerprint();
    protocol.sendStun(response, addr).catch((e) => {
      log("sendStun error", e);
    });

    if (this.checkList.length === 0 && !this.earlyChecksDone) {
      this.earlyChecks.push([verified, addr, protocol]);
    } else {
      this.checkIncoming(verified, addr, protocol);
    }

    if (this.spedRuntime && generation === this.generation) {
      const pair = this.findPairByAddr(protocol, addr);
      if (pair) {
        this.spedRuntime.pinHandshakePath(pair);
      }
      await this.maybeSendSpedFallback(protocol, addr, generation);
    }
  }

  private getCandidatePromises(addresses: string[], timeout = 5) {
    const candidatePromises: Promise<unknown>[] = [];
    const { stunServer, turnServer } = this;
    const { turnUsername, turnPassword } = this.options;
    const gatherIceLite = this.iceLite;
    const gatherRelayOnly =
      !gatherIceLite &&
      this.options.forceTurn &&
      turnServer &&
      turnUsername &&
      turnPassword;

    addresses = addresses.filter((address) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      if (this.protocols.find((protocol) => protocol.localIp === address)) {
        return false;
      }
      return true;
    });

    const localStunPromises = gatherRelayOnly
      ? []
      : addresses.map(async (address) => {
          // # create transport
          const protocol = new StunProtocol();
          this.ensureProtocol(protocol);
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.options.portRange,
              this.options.interfaceAddresses,
            );

            protocol.localIp = address;
            this.protocols.push(protocol);

            log("protocol", protocol.localIp);

            // # add host candidate
            const candidateAddress: Address = [
              address,
              protocol.getExtraInfo()[1],
            ];

            protocol.localCandidate = new Candidate(
              candidateFoundation("host", "udp", candidateAddress[0]),
              1,
              "udp",
              candidatePriority("host", { transport: "udp" }),
              candidateAddress[0],
              candidateAddress[1],
              "host",
              undefined,
              undefined,
              undefined,
              this.generation,
              this.localUsername,
            );

            this.pairLocalProtocol(protocol);
            this.appendLocalCandidate(protocol.localCandidate);

            return protocol;
          } catch (error) {
            log("error protocol STUN", error);
          }
        });

    if (!gatherRelayOnly) {
      candidatePromises.push(
        ...localStunPromises.map((localPromise) =>
          localPromise.then((protocol) => protocol?.localCandidate),
        ),
      );
    }

    if (!gatherRelayOnly && this.options.useTcp) {
      const tcpCandidatePromises = addresses.map(async (address) => {
        // Passive candidates open a listening TCP server; skip them when the
        // agent only makes outbound connections (tcpPassive === false). Active
        // candidates below still dial out, so direct TCP egress is unaffected.
        if (this.options.tcpPassive !== false) {
          const passiveProtocol = new TcpPassiveProtocol();
          this.ensureProtocol(passiveProtocol);
          await passiveProtocol.connectionMade(address, this.options.portRange);
          passiveProtocol.localIp = address;
          passiveProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "passive",
            }),
            address,
            passiveProtocol.listeningPort,
            "host",
            undefined,
            undefined,
            "passive",
            this.generation,
            this.localUsername,
          );
          this.protocols.push(passiveProtocol);
          this.appendLocalCandidate(passiveProtocol.localCandidate);
        }

        if (!gatherIceLite) {
          const activeProtocol = new TcpActiveProtocol();
          this.ensureProtocol(activeProtocol);
          await activeProtocol.connectionMade(address);
          activeProtocol.localIp = address;
          activeProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "active",
            }),
            address,
            9,
            "host",
            undefined,
            undefined,
            "active",
            this.generation,
            this.localUsername,
          );
          this.protocols.push(activeProtocol);
          this.pairLocalProtocol(activeProtocol);
          this.appendLocalCandidate(activeProtocol.localCandidate);
        }
      });

      candidatePromises.push(...tcpCandidatePromises);
    }

    if (!gatherIceLite && !gatherRelayOnly && stunServer) {
      const stunCandidatePromises = localStunPromises.map(
        async (protocolPromise) => {
          const protocol = await protocolPromise;
          if (!protocol) return;

          const stunCandidatePromise = new Promise<Candidate | void>(
            async (r, f) => {
              const timer = setTimeout(f, timeout * 1000);
              if (
                protocol.localCandidate?.host &&
                isIPv4(protocol.localCandidate?.host)
              ) {
                const candidate = await serverReflexiveCandidate(
                  protocol,
                  stunServer,
                ).catch((error) => {
                  log("error", error);
                });
                if (candidate) {
                  this.appendLocalCandidate(candidate);
                }

                clearTimeout(timer);
                r(candidate);
              } else {
                clearTimeout(timer);
                r();
              }
            },
          ).catch((error) => {
            log("query STUN server", error);
          });

          return stunCandidatePromise;
        },
      );

      candidatePromises.push(...stunCandidatePromises);
    }

    if (!gatherIceLite && turnServer && turnUsername && turnPassword) {
      const turnCandidatePromise = (async () => {
        const turnTransport = this.options.turnTransport ?? "udp";
        const protocol = await createStunOverTurnClient(
          {
            address: turnServer,
            username: turnUsername,
            password: turnPassword,
          },
          {
            portRange: this.options.portRange,
            interfaceAddresses: this.options.interfaceAddresses,
            transport: turnTransport,
            tlsOptions: this.options.turnTlsOptions,
          },
        ).catch(async (e) => {
          if (turnTransport === "udp") {
            return await createStunOverTurnClient(
              {
                address: turnServer,
                username: turnUsername,
                password: turnPassword,
              },
              {
                portRange: this.options.portRange,
                interfaceAddresses: this.options.interfaceAddresses,
                transport: "tcp",
              },
            );
          } else {
            throw e;
          }
        });
        this.ensureProtocol(protocol);
        this.protocols.push(protocol);

        const candidateAddress = protocol.turn.relayedAddress;
        const relatedAddress = protocol.turn.mappedAddress;

        log("turn candidateAddress", candidateAddress);

        protocol.localCandidate = new Candidate(
          candidateFoundation("relay", "udp", candidateAddress[0]),
          1,
          "udp",
          candidatePriority("relay"),
          candidateAddress[0],
          candidateAddress[1],
          "relay",
          relatedAddress[0],
          relatedAddress[1],
          undefined,
          this.generation,
          this.localUsername,
        );
        this.appendLocalCandidate(protocol.localCandidate);

        return protocol.localCandidate;
      })().catch((error) => {
        log("query TURN server", error);
      });

      candidatePromises.push(turnCandidatePromise);
    }

    return candidatePromises;
  }

  async connect() {
    // """
    // Perform ICE handshake.
    //
    // This coroutine returns if a candidate pair was successfully nominated
    // and raises an exception otherwise.
    // """
    log("start connect ice");
    if (!this.localCandidatesEnd) {
      if (!this.localCandidatesStart) {
        throw new Error("Local candidates gathering was not performed");
      }
    }
    if (!this.remoteUsername || !this.remotePassword) {
      throw new Error("Remote username or password is missing");
    }

    // # 5.7.1. Forming Candidate Pairs
    for (const c of this.remoteCandidates) {
      this.pairRemoteCandidate(c);
    }
    this.sortCheckList();

    if (!this.iceLite) {
      this.unfreezeInitial();
    }

    log("earlyChecks", this.localPassword, this.earlyChecks.length);
    // # handle early checks
    for (const earlyCheck of this.earlyChecks) {
      this.checkIncoming(...earlyCheck);
      const [, addr, protocol] = earlyCheck;
      await this.maybeSendSpedFallback(protocol, addr, this.generation);
    }
    this.earlyChecks = [];
    this.earlyChecksDone = true;

    if (this.iceLite) {
      if (!this.nominated) {
        let res: number = ICE_FAILED;
        while (!this.checkListDone && this.state !== "closed") {
          res = await this.checkListState.get();
          log("checkListState", res);
          if (res === ICE_COMPLETED) {
            break;
          }
        }

        if (res !== ICE_COMPLETED && !this.nominated) {
          throw new Error("ICE negotiation failed");
        }
      }

      this.setState("connected");
      return;
    }

    // # perform checks
    // 5.8.  Scheduling Checks
    for (;;) {
      if (this.state === "closed") break;
      if (!this.schedulingChecks()) break;
      await timers.setTimeout(20);
    }

    // # wait for completion
    let res: number = ICE_FAILED;
    while (res === ICE_FAILED && this.state !== "closed") {
      if (this.nominated || this.checkListDone) {
        res = ICE_COMPLETED;
        break;
      }
      if (this.hasOutstandingChecks() || this.isWaitingForRemoteNomination()) {
        res = await this.checkListState.get();
        log("checkListState", res);
        continue;
      }
      if (!this.canLearnIncomingTcpPair()) {
        break;
      }
      const learned = await this.waitForIncomingTcpPair();
      if (!learned) {
        break;
      }
    }

    // # cancel remaining checks
    for (const check of this.checkList) {
      check.handle?.resolve?.();
    }

    if (res !== ICE_COMPLETED && !this.nominated) {
      throw new Error("ICE negotiation failed");
    }

    // # start consent freshness tests
    this.queryConsent();

    this.setState("connected");
  }

  private unfreezeInitial() {
    // # unfreeze first pair for the first component
    const [firstPair] = this.checkList;
    if (!firstPair) return;
    if (firstPair.state === CandidatePairState.FROZEN) {
      firstPair.updateState(CandidatePairState.WAITING);
    }

    // # unfreeze pairs with same component but different foundations
    const seenFoundations = new Set(firstPair.localCandidate.foundation);
    for (const pair of this.checkList) {
      if (
        pair.component === firstPair.component &&
        !seenFoundations.has(pair.localCandidate.foundation) &&
        pair.state === CandidatePairState.FROZEN
      ) {
        pair.updateState(CandidatePairState.WAITING);
        seenFoundations.add(pair.localCandidate.foundation);
      }
    }
  }

  // 5.8 Scheduling Checks
  private schedulingChecks() {
    // Ordinary Check
    {
      // # find the highest-priority pair that is in the waiting state
      const pair = this.checkList
        .filter((pair) => {
          if (
            this.options.forceTurn &&
            pair.protocol.type === StunProtocol.type
          )
            return false;
          return true;
        })
        .find((pair) => pair.state === CandidatePairState.WAITING);
      if (pair) {
        pair.handle = this.checkStart(pair);
        return true;
      }
    }

    {
      // # find the highest-priority pair that is in the frozen state
      const pair = this.checkList.find(
        (pair) => pair.state === CandidatePairState.FROZEN,
      );
      if (pair) {
        pair.handle = this.checkStart(pair);
        return true;
      }
    }

    // # if we expect more candidates, keep going
    if (!this.remoteCandidatesEnd) {
      return !this.checkListDone;
    }

    return false;
  }

  /**
   * Stop consent request cadence, expiry timer, and outstanding transactions.
   * Does not change ICE state by itself.
   */
  private stopConsentLifecycle() {
    this.consentSessionId++;
    this.consentFresh = false;
    if (this.consentExpiryTimer !== undefined) {
      clearTimeout(this.consentExpiryTimer);
      this.consentExpiryTimer = undefined;
    }
    this.consentRequestAbort?.abort();
    this.consentRequestAbort = undefined;
    const handle = this.queryConsentHandle;
    this.queryConsentHandle = undefined;
    // Resolve after clearing the field so a stale onCancel cannot wipe a replacement.
    handle?.resolve?.();
  }

  /**
   * ICE-lite interop only (not required by RFC 7675): mirror libwebrtc
   * semi-aggressive nomination — attach USE-CANDIDATE when we are controlling,
   * the remote is ICE-lite, and the target is the current selected pair.
   */
  private shouldNominateConsentRequest(pair: CandidatePair): boolean {
    return (
      this.iceControlling && this.remoteIsLite && this.nominated?.id === pair.id
    );
  }

  private canSendApplicationData(): boolean {
    if (!this.nominated) {
      return false;
    }
    if (this.state === "closed" || this.state === "failed") {
      return false;
    }
    // Local ICE-lite does not run consent checks; full agents need fresh consent.
    if (this.iceLite) {
      return true;
    }
    return this.consentFresh;
  }

  private abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // RFC 7675 consent freshness
  private queryConsent = () => {
    if (this.iceLite) {
      return;
    }

    // Invalidate any previous consent session before starting a new one.
    this.stopConsentLifecycle();
    const sessionId = this.consentSessionId;
    this.consentFresh = true;

    const handle = cancelable<void>(async (_, __, onCancel) => {
      let canceled = false;
      const cancelEvent = new AbortController();

      const clearConsentExpiry = () => {
        if (this.consentExpiryTimer === undefined) {
          return;
        }
        clearTimeout(this.consentExpiryTimer);
        this.consentExpiryTimer = undefined;
      };

      const refreshConsentExpiry = () => {
        // Only the active session may refresh the shared expiry timer.
        if (canceled || sessionId !== this.consentSessionId) {
          return;
        }
        clearConsentExpiry();
        this.consentExpiryTimer = setTimeout(() => {
          this.consentExpiryTimer = undefined;
          if (canceled || sessionId !== this.consentSessionId) {
            return;
          }
          if (this.state === "closed" || this.state === "failed") {
            return;
          }
          log("Consent to send expired");
          // Expire independently of request cadence / failure count (RFC 7675).
          this.consentFresh = false;
          this.consentSessionId++;
          this.consentRequestAbort?.abort();
          this.consentRequestAbort = undefined;
          if (this.queryConsentHandle === handle) {
            this.queryConsentHandle = undefined;
          }
          canceled = true;
          cancelEvent.abort();
          // Transport stays available for ICE restart; explicit close() uses "closed".
          this.setState("failed");
        }, CONSENT_TIMEOUT * 1000);
      };

      onCancel.once(() => {
        canceled = true;
        // Avoid clearing a replacement session's timer/handle.
        if (sessionId === this.consentSessionId) {
          clearConsentExpiry();
          this.consentRequestAbort?.abort();
          this.consentRequestAbort = undefined;
        }
        cancelEvent.abort();
        if (this.queryConsentHandle === handle) {
          this.queryConsentHandle = undefined;
        }
      });

      // Initial ICE check success is the first valid consent response.
      refreshConsentExpiry();

      const randomizedConsentInterval = () =>
        CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000;

      // Cadence is measured between request *starts*, not response completions.
      let nextConsentAt = Date.now() + randomizedConsentInterval();
      const isTerminalState = () =>
        this.state === "closed" || this.state === "failed";

      try {
        while (
          !isTerminalState() &&
          !canceled &&
          sessionId === this.consentSessionId
        ) {
          await this.abortableDelay(
            Math.max(0, nextConsentAt - Date.now()),
            cancelEvent.signal,
          );

          if (
            canceled ||
            isTerminalState() ||
            sessionId !== this.consentSessionId
          ) {
            break;
          }

          // Fix next start time before awaiting any response (independent timers).
          nextConsentAt = Date.now() + randomizedConsentInterval();

          const nominated = this.nominated;
          if (!nominated) {
            break;
          }

          const pairId = nominated.id;
          const generation = this.generation;
          const remotePassword = this.remotePassword;
          const { localUsername, remoteUsername, iceControlling } = this;

          const request = this.buildRequest({
            nominate: this.shouldNominateConsentRequest(nominated),
            localUsername,
            remoteUsername,
            iceControlling,
            localCandidate: nominated.localCandidate,
          });
          if (!this.decorateSpedRequest(request, nominated.protocol)) {
            continue;
          }

          this.consentRequestAbort?.abort();
          const requestAbort = new AbortController();
          this.consentRequestAbort = requestAbort;

          nominated.consentRequestsSent++;
          nominated.requestsSent++;

          // RTT-aware wait (floor 500ms); independent of retransmissions: 0.
          const responseTimeout = consentResponseTimeoutMs(nominated.rtt);
          const requestStartedAt = performance.now();

          // Do not await here: response wait must not stretch the 4–6s cadence.
          nominated.protocol
            .request(
              request,
              nominated.remoteAddr,
              Buffer.from(remotePassword, "utf8"),
              {
                retransmissions: 0,
                responseTimeout,
                signal: requestAbort.signal,
                onRequestSent: (attempt) => {
                  if (attempt > 0) {
                    nominated.retransmissionsSent++;
                  }
                },
              },
            )
            .then(async ([response, addr]) => {
              // Accept only responses for the current pair / generation / session.
              // Address / MESSAGE-INTEGRITY / response class are enforced in Transaction + protocol.
              if (sessionId !== this.consentSessionId || canceled) {
                return;
              }
              const state = this.state;
              if (state === "closed" || state === "failed") {
                return;
              }
              if (this.nominated?.id !== pairId) {
                return;
              }
              if (this.generation !== generation) {
                return;
              }
              if (this.remotePassword !== remotePassword) {
                return;
              }

              const rtt = (performance.now() - requestStartedAt) / 1000; // seconds
              nominated.rtt = rtt;
              nominated.totalRoundTripTime += rtt;
              nominated.roundTripTimeMeasurements++;

              nominated.responsesReceived++;
              this.consentFresh = true;
              refreshConsentExpiry();
              if (state === "disconnected") {
                this.setState("connected");
              }
              await this.consumeSpedStun(
                response,
                addr,
                nominated.protocol,
                nominated,
                generation,
              );
            })
            .catch((error) => {
              // Individual request loss is expected; keep monitoring (RFC 7675).
              if (
                sessionId === this.consentSessionId &&
                this.nominated?.id === pairId
              ) {
                log("no stun response", error);
              }
            });
        }
      } catch (error) {
        // Abort during delay is normal on cancel / expire.
      } finally {
        if (sessionId === this.consentSessionId) {
          clearConsentExpiry();
        }
      }
    });
    this.queryConsentHandle = handle;
  };

  async close() {
    // """
    // Close the connection.
    // """

    this.setState("closed");
    this.cancelIncomingTcpPairWait();

    // # stop consent freshness tests
    this.stopConsentLifecycle();

    // # stop check list
    if (this.checkList && !this.checkListDone) {
      this.checkListState.put(
        new Promise((r) => {
          r(ICE_FAILED);
        }),
      );
    }

    this.nominated = undefined;
    for (const protocol of this.protocols) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];

    this.lookup?.close?.();
    this.lookup = undefined;
    this.spedCarryEpoch++;
    this.spedCarryInFlight = false;
    this.spedCarryQueued = false;
    this.spedSolicitPeerCarry = false;
    this.spedRuntime?.abort();
    this.spedRuntime = undefined;
  }

  private setState(state: IceState) {
    this.state = state;
    this.stateChanged.execute(state);
    if (state === "failed" || state === "closed") {
      this.spedRuntime?.abort();
    }
  }

  async addRemoteCandidate(remoteCandidate: Candidate | undefined) {
    // """
    // Add a remote candidate or signal end-of-candidates.

    // To signal end-of-candidates, pass `None`.

    // :param remote_candidate: A :class:`Candidate` instance or `None`.
    // """

    if (!remoteCandidate) {
      this.remoteCandidatesEnd = true;
      return;
    }

    if (remoteCandidate.host.includes(".local")) {
      try {
        if (!this.lookup) {
          this.lookup = new MdnsLookup();
        }
        const host = await this.lookup.lookup(remoteCandidate.host);
        remoteCandidate.host = host;
      } catch (error) {
        return;
      }
    }

    try {
      validateRemoteCandidate(remoteCandidate);
    } catch (error) {
      return;
    }

    log("addRemoteCandidate", remoteCandidate);
    this._remoteCandidates.push(remoteCandidate);

    this.pairRemoteCandidate(remoteCandidate);
    this.sortCheckList();
  }

  send = async (data: Buffer) => {
    // RFC 7675: after consent expiry, do not send application data on the 5-tuple.
    if (!this.canSendApplicationData()) {
      return;
    }
    const activePair = this.nominated!;
    await activePair.protocol.sendData(data, activePair.remoteAddr);

    // Update statistics
    activePair.packetsSent++;
    activePair.bytesSent += data.length;
  };

  getDefaultCandidate() {
    const candidates = this.localCandidates.sort(
      (a, b) => a.priority - b.priority,
    );
    const [candidate] = candidates;
    return candidate;
  }

  // for test only
  set remoteCandidates(value: Candidate[]) {
    if (this.remoteCandidatesEnd)
      throw new Error("Cannot set remote candidates after end-of-candidates.");
    this._remoteCandidates = [];
    for (const remoteCandidate of value) {
      try {
        validateRemoteCandidate(remoteCandidate);
      } catch (error) {
        continue;
      }
      this._remoteCandidates.push(remoteCandidate);
    }

    this.remoteCandidatesEnd = true;
  }
  get remoteCandidates() {
    return this._remoteCandidates;
  }

  get candidatePairs() {
    return this.checkList;
  }

  private sortCheckList() {
    sortCandidatePairs(this.checkList, this.iceControlling);
  }

  private findPair(protocol: Protocol, remoteCandidate: Candidate) {
    const pair = this.checkList.find(
      (pair) =>
        pair.protocol === protocol && pair.remoteCandidate === remoteCandidate,
    );
    return pair;
  }

  private findPairByAddr(protocol: Protocol, addr: Address) {
    return this.checkList.find(
      (pair) =>
        pair.protocol === protocol &&
        pair.remoteAddr[0] === addr[0] &&
        pair.remoteAddr[1] === addr[1],
    );
  }

  /**
   * Datagrams map to a pair by protocol and remote 5-tuple.
   * Nominated is preferred only when the source matches that pair.
   */
  private resolveDatagramPair(
    protocol: Protocol,
    addr?: Address,
  ): CandidatePair | undefined {
    if (addr) {
      if (
        this.nominated?.protocol === protocol &&
        this.nominated.remoteAddr[0] === addr[0] &&
        this.nominated.remoteAddr[1] === addr[1]
      ) {
        return this.nominated;
      }
      return this.findPairByAddr(protocol, addr);
    }
    if (this.nominated?.protocol === protocol) {
      return this.nominated;
    }
    return this.checkList.find((candidate) => candidate.protocol === protocol);
  }

  private hasOutstandingChecks(): boolean {
    return this.checkList.some(
      (pair) =>
        pair.state === CandidatePairState.WAITING ||
        pair.state === CandidatePairState.FROZEN ||
        pair.state === CandidatePairState.IN_PROGRESS,
    );
  }

  private isWaitingForRemoteNomination(): boolean {
    return (
      !this.iceControlling &&
      this.checkList.some((pair) => pair.state === CandidatePairState.SUCCEEDED)
    );
  }

  private canLearnIncomingTcpPair(): boolean {
    if (this.checkListDone || this.nominated || this.state === "closed") {
      return false;
    }
    if (this.hasOutstandingChecks()) {
      return false;
    }
    const hasLocalPassive = this.protocols.some(
      (protocol) =>
        protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
        protocol.localCandidate.tcptype === "passive",
    );
    if (!hasLocalPassive) {
      return false;
    }
    return this.remoteCandidates.some((candidate) =>
      isTcpActiveCandidate(candidate),
    );
  }

  private waitForIncomingTcpPair(): Promise<boolean> {
    if (this.state === "closed") {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const settle = (learned: boolean) => {
        if (this.incomingTcpPairWait?.settle !== settle) {
          return;
        }
        this.incomingTcpPairWait = undefined;
        clearTimeout(timer);
        resolve(learned);
      };
      const timer = setTimeout(
        () => settle(false),
        stunTransactionLifetimeMs(),
      );
      this.incomingTcpPairWait = { settle };
    });
  }

  private cancelIncomingTcpPairWait() {
    this.incomingTcpPairWait?.settle(false);
  }

  private hasViableTcpActivePair(component: number): boolean {
    return this.checkList.some(
      (candidate) =>
        candidate.component === component &&
        isTcpLocalActivePair(candidate) &&
        candidate.state !== CandidatePairState.FAILED,
    );
  }

  /**
   * One TCP nomination per component. Prefer local-active while it can still
   * succeed; fall back to local-passive when no active pair remains.
   */
  private canSendTcpNomination(pair: CandidatePair): boolean {
    if (pair.localCandidate.transport.toLowerCase() !== "tcp") {
      return true;
    }
    if (isTcpLocalPassivePair(pair)) {
      return !this.hasViableTcpActivePair(pair.component);
    }
    return true;
  }

  private maybeNominateTcpFallback(component: number) {
    if (!this.iceControlling || this.nominated) {
      return;
    }
    if (this.hasViableTcpActivePair(component)) {
      return;
    }
    const fallback = this.checkList.find(
      (candidate) =>
        candidate.component === component &&
        candidate.state === CandidatePairState.SUCCEEDED &&
        isTcpLocalPassivePair(candidate),
    );
    if (!fallback) {
      return;
    }
    this.nominating = false;
    fallback.handle = this.checkStart(fallback);
  }

  private decorateSpedRequest(request: Message, protocol: Protocol): boolean {
    return this.spedRuntime?.decorateOutgoing(request, protocol) ?? true;
  }

  private isStaleConnectivityCheck(
    pair: CandidatePair,
    generation: number,
  ): boolean {
    if (generation !== this.generation) {
      return true;
    }
    // Restart clears the list. Unlisted pair in an empty list is a unit-test
    // checkStart, not a stale generation.
    if (this.checkList.length === 0) {
      return false;
    }
    return !this.checkList.includes(pair);
  }

  private abandonInFlightStunTransactions() {
    for (const protocol of this.protocols) {
      const transactions = (
        protocol as {
          transactions?: Record<string, { abandon?: () => void }>;
        }
      ).transactions;
      if (!transactions) {
        continue;
      }
      for (const transaction of Object.values(transactions)) {
        transaction.abandon?.();
      }
    }
  }

  private maybeFlushSpedCarry() {
    if (this.iceLite) {
      return;
    }
    if (this.spedIncomingStunDepth > 0) {
      this.spedCarryQueued = true;
      return;
    }
    if (this.isTerminalIceState()) {
      return;
    }
    void this.flushSpedCarry();
  }

  private isTerminalIceState() {
    const state = this.state as IceState;
    return state === "failed" || state === "closed";
  }

  /**
   * Send a Binding carrying current L1 when ICE checks will not
   * do so soon enough (e.g. Finished after aggressive nomination).
   * ICE-Lite never originates connectivity Binding Requests.
   */
  private async flushSpedCarry() {
    if (this.iceLite) {
      return;
    }
    if (this.isTerminalIceState()) {
      return;
    }
    const runtime = this.spedRuntime;
    if (!runtime?.session.embedding) {
      return;
    }
    if (this.spedCarryInFlight) {
      this.spedCarryQueued = true;
      return;
    }
    if (!runtime.session.hasL1 && !this.spedSolicitPeerCarry) {
      return;
    }
    if (!this.remoteUsername || !this.remotePassword) {
      return;
    }
    this.spedSolicitPeerCarry = false;

    const pair =
      this.nominated ??
      this.checkList.find(
        (candidate) =>
          candidate.state === CandidatePairState.SUCCEEDED ||
          candidate.state === CandidatePairState.IN_PROGRESS,
      ) ??
      (runtime.lastPath && isAuthenticatedHandshakePair(runtime.lastPath)
        ? runtime.lastPath
        : undefined);
    const protocol = pair?.protocol;
    const addr = pair?.remoteAddr;
    if (!protocol || !addr || !runtime.shouldDecorate(protocol)) {
      return;
    }

    this.spedCarryInFlight = true;
    const generation = this.generation;
    const carryEpoch = this.spedCarryEpoch;
    let requestSucceeded = false;
    try {
      const request = this.buildRequest({
        nominate: false,
        localUsername: this.localUsername,
        remoteUsername: this.remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: protocol.localCandidate,
      });
      if (!runtime.decorateOutgoing(request, protocol)) {
        return;
      }
      const retransmissions =
        protocol.localCandidate?.transport.toLowerCase() === "tcp" ? 0 : 2;
      const [response, responseAddr] = await protocol.request(
        request,
        addr,
        Buffer.from(this.remotePassword, "utf8"),
        retransmissions,
      );
      if (
        generation !== this.generation ||
        carryEpoch !== this.spedCarryEpoch
      ) {
        return;
      }
      requestSucceeded = true;
      await this.consumeSpedStun(
        response,
        responseAddr,
        protocol,
        pair,
        generation,
      );
    } catch {
      // Loss is acceptable; connectivity checks / consent retry L1.
    } finally {
      this.spedCarryInFlight = false;
      const stale =
        carryEpoch !== this.spedCarryEpoch ||
        generation !== this.generation ||
        this.isTerminalIceState();
      if (!stale) {
        if (this.spedCarryQueued) {
          this.spedCarryQueued = false;
          void this.flushSpedCarry();
        } else if (
          requestSucceeded &&
          runtime.session.embedding &&
          runtime.session.hasL1
        ) {
          void this.flushSpedCarry();
        }
      }
    }
  }

  private async consumeSpedStun(
    message: Message,
    addr: Address,
    protocol: Protocol,
    pair: CandidatePair | undefined,
    generation: number,
  ) {
    const runtime = this.spedRuntime;
    if (generation !== this.generation) {
      return;
    }
    if (
      !runtime?.shouldDecorate(protocol) ||
      !runtime.isLiveGeneration(generation)
    ) {
      return;
    }
    const result = await runtime.handleAuthenticatedStun(
      message,
      addr,
      generation,
      protocol,
    );
    if (
      generation !== this.generation ||
      !runtime.isLiveGeneration(generation)
    ) {
      return;
    }
    if (pair) {
      runtime.syncRtt(pair);
      runtime.pinHandshakePath(pair);
    }
    if (result.inject) {
      this.spedSolicitPeerCarry = true;
      this.maybeFlushSpedCarry();
    }
    await this.maybeSendSpedFallback(protocol, addr, generation);
  }

  private applyIceControlling(iceControlling: boolean) {
    this._iceControlling = iceControlling;
    for (const pair of this.checkList) {
      pair.iceControlling = iceControlling;
    }
  }

  private switchRole(iceControlling: boolean) {
    log("switch role", iceControlling);
    // Role conflicts must be repaired even after a prior generation or while
    // connectivity checks are in flight (RFC 8445 §7.2.5.1 / §7.3.1.1).
    if (this.iceLite) {
      iceControlling = false;
    }
    this.applyIceControlling(iceControlling);
    this.sortCheckList();
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      // Updating the Nominated Flag

      // https://www.rfc-editor.org/rfc/rfc8445#section-7.3.1.5,
      // Once the nominated flag is set for a component of a data stream, it
      // concludes the ICE processing for that component.  See Section 8.
      // So disallow overwriting of the pair nominated for that component
      if (
        pair.nominated &&
        // remoteのgenerationをチェックする.localのgenerationは更新が間に合わないかもしれないのでチェックしない
        (pair.remoteCandidate.generation != undefined
          ? pair.remoteCandidate.generation === this.generation
          : true) &&
        this.nominated == undefined
      ) {
        log("nominated", pair.toJSON());
        this.nominated = pair;
        this.nominating = false;
        this.pruneTcpConnections(pair);

        // After resetNominatedPair / renomination while already connected,
        // restart consent freshness on the new selected pair.
        if (
          !this.iceLite &&
          (this.state === "connected" || this.state === "completed")
        ) {
          this.queryConsent();
        }

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream.
        for (const p of this.checkList) {
          if (
            p.component === pair.component &&
            [CandidatePairState.WAITING, CandidatePairState.FROZEN].includes(
              p.state,
            )
          ) {
            p.updateState(CandidatePairState.FAILED);
          }
        }
      }

      // Once there is at least one nominated pair in the valid list for
      // every component of at least one media stream and the state of the
      // check list is Running:
      if (this.nominated) {
        if (!this.checkListDone) {
          log("ICE completed");
          this.checkListState.put(new Promise((r) => r(ICE_COMPLETED)));
          this.checkListDone = true;
        }
        return;
      }

      log("not completed", pair.toJSON());

      // 7.1.3.2.3.  Updating Pair States
      for (const p of this.checkList) {
        if (
          p.localCandidate.foundation === pair.localCandidate.foundation &&
          p.state === CandidatePairState.FROZEN
        ) {
          p.updateState(CandidatePairState.WAITING);
        }
      }
    }

    if (pair.state === CandidatePairState.FAILED) {
      this.maybeNominateTcpFallback(pair.component);
    }

    {
      const list = [CandidatePairState.SUCCEEDED, CandidatePairState.FAILED];
      if (this.checkList.find(({ state }) => !list.includes(state))) {
        return;
      }
    }

    if (!this.iceControlling) {
      const target = CandidatePairState.SUCCEEDED;
      if (this.checkList.find(({ state }) => state === target)) {
        return;
      }
    }

    if (!this.checkListDone) {
      log("ICE failed");
      this.checkListState.put(
        new Promise((r) => {
          r(ICE_FAILED);
        }),
      );
    }
  }

  // 3.  Terminology : Check
  checkStart = (pair: CandidatePair) =>
    cancelable<void>(async (r) => {
      // """
      // Starts a check.
      // """

      log("check start", pair.toJSON());

      pair.updateState(CandidatePairState.IN_PROGRESS);
      const result: { response?: Message; addr?: Address } = {};
      const { remotePassword, remoteUsername, generation } = this;
      const localUsername = pair.localCandidate.ufrag ?? this.localUsername;
      const stopIfStale = () => {
        if (!this.isStaleConnectivityCheck(pair, generation)) {
          return false;
        }
        r();
        return true;
      };

      // TCP: prefer local-active, but nominate local-passive when no active
      // pair can still succeed (send-only peer, or active already failed).
      const nominate =
        this.iceControlling &&
        !this.remoteIsLite &&
        this.canSendTcpNomination(pair);
      const request = this.buildRequest({
        nominate,
        localUsername,
        remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: pair.localCandidate,
      });
      if (!this.decorateSpedRequest(request, pair.protocol)) {
        if (stopIfStale()) {
          return;
        }
        pair.updateState(CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // Record start time for RTT calculation
      const startTime = performance.now();

      try {
        pair.requestsSent++;
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(remotePassword, "utf8"),
          pair.localCandidate.transport.toLowerCase() === "tcp" ? 0 : 4,
          (attempt) => {
            if (attempt > 0) {
              pair.retransmissionsSent++;
            }
          },
        );
        if (stopIfStale()) {
          return;
        }
        pair.responsesReceived++;

        // Calculate RTT
        const endTime = performance.now();
        const rtt = (endTime - startTime) / 1000; // Convert to seconds

        // Update RTT statistics
        pair.rtt = rtt;
        pair.totalRoundTripTime += rtt;
        pair.roundTripTimeMeasurements++;

        log("response received", request.toJSON(), response.toJSON(), addr, {
          localUsername,
          remoteUsername,
          remotePassword,
          generation,
          rtt,
        });
        result.response = response;
        result.addr = addr;
        await this.consumeSpedStun(
          response,
          addr,
          pair.protocol,
          pair,
          generation,
        );
        if (stopIfStale()) {
          return;
        }
      } catch (error: any) {
        if (stopIfStale()) {
          return;
        }
        const exc: TransactionError = error;
        // 7.1.3.1.  Failure Cases
        log(
          "failure case",
          request.toJSON(),
          exc.response ? JSON.stringify(exc.response.toJSON(), null, 2) : error,
          {
            localUsername,
            remoteUsername,
            remotePassword,
            generation,
          },
          pair.remoteAddr,
        );
        if (exc.response?.getAttributeValue("ERROR-CODE")[0] === 487) {
          if (request.attributesKeys.includes("ICE-CONTROLLED")) {
            this.switchRole(true);
          } else if (request.attributesKeys.includes("ICE-CONTROLLING")) {
            this.switchRole(false);
          }
          await this.checkStart(pair).awaitable;
          r();
          return;
        }
        if (exc.response?.getAttributeValue("ERROR-CODE")[0] === 401) {
          log("retry 401", pair.toJSON());
          await this.checkStart(pair).awaitable;
          r();
          return;
        } else {
          // timeout
          log("checkStart CandidatePairState.FAILED", pair.toJSON());
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
      }

      if (stopIfStale()) {
        return;
      }

      // # check remote address matches
      if (
        result.addr[0] !== pair.remoteAddr[0] ||
        result.addr[1] !== pair.remoteAddr[1]
      ) {
        pair.updateState(CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // # success
      if (nominate || pair.remoteNominated) {
        // # nominated by agressive nomination or the remote party
        pair.nominated = true;
      } else if (
        this.iceControlling &&
        !this.nominating &&
        this.canSendTcpNomination(pair)
      ) {
        // # perform regular nomination
        this.nominating = true;
        const request = this.buildRequest({
          nominate: true,
          localUsername,
          remoteUsername,
          iceControlling: this.iceControlling,
          localCandidate: pair.localCandidate,
        });
        if (!this.decorateSpedRequest(request, pair.protocol)) {
          if (stopIfStale()) {
            return;
          }
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
        try {
          pair.requestsSent++;
          const [nomResponse, nomAddr] = await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8"),
            pair.localCandidate.transport.toLowerCase() === "tcp" ? 0 : 4,
            (attempt) => {
              if (attempt > 0) {
                pair.retransmissionsSent++;
              }
            },
          );
          if (stopIfStale()) {
            return;
          }
          pair.responsesReceived++;
          await this.consumeSpedStun(
            nomResponse,
            nomAddr,
            pair.protocol,
            pair,
            generation,
          );
          if (stopIfStale()) {
            return;
          }
        } catch {
          if (stopIfStale()) {
            return;
          }
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
        pair.nominated = true;
      }

      if (stopIfStale()) {
        return;
      }
      pair.updateState(CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

  private addPair(pair: CandidatePair) {
    this.checkList.push(pair);
    this.sortCheckList();
    this.incomingTcpPairWait?.settle(true);
  }

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: Protocol) {
    // """
    // Handle a successful incoming check.
    // """

    const txUsername = message.getAttributeValue("USERNAME");
    const { remoteUsername: localUsername } = decodeTxUsername(txUsername);

    // find remote candidate
    let remoteCandidate: Candidate | undefined;
    const [host, port] = addr;
    for (const c of this.remoteCandidates) {
      if (c.host === host && c.port === port) {
        remoteCandidate = c;
        break;
      }
    }
    if (!remoteCandidate) {
      // 7.2.1.3.  Learning Peer Reflexive Candidates
      remoteCandidate = new Candidate(
        randomString(10),
        1,
        protocol.localCandidate?.transport ?? "udp",
        message.getAttributeValue("PRIORITY"),
        host,
        port,
        "prflx",
        undefined,
        undefined,
        protocol.localCandidate?.transport === "tcp"
          ? remoteTcpTypeForIncoming(protocol.localCandidate.tcptype)
          : undefined,
        undefined,
        undefined,
      );
      this._remoteCandidates.push(remoteCandidate);
    }

    // find pair
    let pair = this.findPair(protocol, remoteCandidate);
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate, this.iceControlling);
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
    pair.noteIncomingRequest(message.transactionIdHex);
    pair.requestsReceived++;
    pair.responsesSent++;
    pair.localCandidate.ufrag = localUsername;

    log("Triggered Checks", message.toJSON(), pair.toJSON(), {
      localUsername: this.localUsername,
      remoteUsername: this.remoteUsername,
      localPassword: this.localPassword,
      remotePassword: this.remotePassword,
      generation: this.generation,
    });

    if (this.iceLite) {
      if (
        message.attributesKeys.includes("USE-CANDIDATE") &&
        !this.iceControlling
      ) {
        pair.remoteNominated = true;
        pair.nominated = true;
        pair.updateState(CandidatePairState.SUCCEEDED);
        this.checkComplete(pair);
      }
      return;
    }

    // 7.2.1.4.  Triggered Checks
    if (
      [CandidatePairState.WAITING, CandidatePairState.FAILED].includes(
        pair.state,
      )
    ) {
      pair.handle = this.checkStart(pair);
    }

    // 7.2.1.5. Updating the Nominated Flag
    if (
      message.attributesKeys.includes("USE-CANDIDATE") &&
      !this.iceControlling
    ) {
      pair.remoteNominated = true;
      if (pair.state === CandidatePairState.SUCCEEDED) {
        pair.nominated = true;
        this.checkComplete(pair);
      }
    }
  }

  private tryPair(protocol: Protocol, remoteCandidate: Candidate) {
    if (
      protocol.localCandidate?.canPairWith(remoteCandidate) &&
      !(
        protocol.localCandidate.transport.toLowerCase() === "tcp" &&
        protocol.localCandidate.tcptype === "passive" &&
        remoteCandidate.type !== "prflx"
      ) &&
      !this.findPair(protocol, remoteCandidate)
    ) {
      const pair = new CandidatePair(
        protocol,
        remoteCandidate,
        this.iceControlling,
      );
      if (
        this.options.filterCandidatePair &&
        !this.options.filterCandidatePair(pair)
      ) {
        return;
      }
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
  }

  private pairLocalProtocol(protocol: Protocol) {
    for (const remoteCandidate of this.remoteCandidates) {
      this.tryPair(protocol, remoteCandidate);
    }
  }

  private pairRemoteCandidate = (remoteCandidate: Candidate) => {
    for (const protocol of this.protocols) {
      this.tryPair(protocol, remoteCandidate);
    }
  };

  private buildRequest({
    nominate,
    remoteUsername,
    localUsername,
    iceControlling,
    localCandidate,
  }: {
    nominate: boolean;
    remoteUsername: string;
    localUsername: string;
    iceControlling: boolean;
    localCandidate?: Candidate;
  }) {
    const txUsername = encodeTxUsername({ remoteUsername, localUsername });
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", txUsername).setAttribute(
      "PRIORITY",
      candidatePriority("prflx", {
        transport: localCandidate?.transport,
        tcptype: localCandidate?.tcptype,
      }),
    );
    if (iceControlling) {
      request.setAttribute("ICE-CONTROLLING", this.tieBreaker);
      if (nominate) {
        request.setAttribute("USE-CANDIDATE", null);
      }
    } else {
      request.setAttribute("ICE-CONTROLLED", this.tieBreaker);
    }
    return request;
  }

  private pruneTcpConnections(selectedPair: CandidatePair) {
    for (const protocol of this.protocols) {
      if (protocol.localCandidate?.transport.toLowerCase() !== "tcp") {
        continue;
      }

      if (
        "pruneForSelection" in protocol &&
        typeof protocol.pruneForSelection === "function"
      ) {
        void protocol.pruneForSelection(
          protocol === selectedPair.protocol
            ? selectedPair.remoteAddr
            : undefined,
        );
      }
    }
  }

  private respondError(
    request: Message,
    addr: Address,
    protocol: Protocol,
    errorCode: [number, string],
  ) {
    const response = new Message(
      request.messageMethod,
      classes.ERROR,
      request.transactionId,
    );
    response
      .setAttribute("ERROR-CODE", errorCode)
      .addMessageIntegrity(Buffer.from(this.localPassword, "utf8"))
      .addFingerprint();
    protocol.sendStun(response, addr).catch((e) => {
      log("sendStun error", e);
    });
  }
}

const encodeTxUsername = ({
  remoteUsername,
  localUsername,
}: {
  remoteUsername: string;
  localUsername: string;
}) => {
  return `${remoteUsername}:${localUsername}`;
};

const decodeTxUsername = (txUsername: string) => {
  const [remoteUsername, localUsername] = txUsername.split(":");
  return { remoteUsername, localUsername };
};
