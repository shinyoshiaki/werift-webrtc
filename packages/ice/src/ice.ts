import { randomBytes } from "crypto";
import { isIPv4 } from "net";

import debug from "debug";
import { Uint64BE } from "int64-buffer";

import isEqual from "lodash/isEqual";
import PCancelable from "p-cancelable";
import { Event } from "rx.mini";
import timers from "timers/promises";

import { InterfaceAddresses } from "../../common/src/network";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import { MdnsLookup } from "./dns/lookup";
import { TransactionError } from "./exceptions";
import { Future, PQueue, future, randomString } from "./helper";
import { classes, methods } from "./stun/const";
import { Message, parseMessage } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { createTurnEndpoint } from "./turn/protocol";
import { Address, Protocol } from "./types/model";
import { getHostAddresses, normalizeFamilyNodeV18 } from "./utils";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

export class Connection {
  localUserName = randomString(4);
  localPassword = randomString(22);
  remotePassword: string = "";
  remoteUsername: string = "";
  remoteIsLite = false;
  checkList: CandidatePair[] = [];
  localCandidates: Candidate[] = [];
  stunServer?: Address;
  turnServer?: Address;
  useIpv4: boolean;
  useIpv6: boolean;
  options: IceOptions;
  remoteCandidatesEnd = false;
  _localCandidatesEnd = false;
  _tieBreaker: bigint = BigInt(new Uint64BE(randomBytes(64)).toString());
  state: IceState = "new";
  lookup?: MdnsLookup;
  restarted = false;

  readonly onData = new Event<[Buffer, number]>();
  readonly stateChanged = new Event<[IceState]>();

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  private nominated?: CandidatePair;
  private nominating = false;
  private checkListDone = false;
  private checkListState = new PQueue<number>();
  private earlyChecks: [Message, Address, Protocol][] = [];
  private localCandidatesStart = false;
  private protocols: Protocol[] = [];
  private queryConsentHandle?: Future;
  private promiseGatherCandidates?: Event<[]>;

  constructor(public iceControlling: boolean, options?: Partial<IceOptions>) {
    this.options = {
      ...defaultOptions,
      ...options,
    };
    const { stunServer, turnServer, useIpv4, useIpv6 } = this.options;
    this.stunServer = validateAddress(stunServer);
    this.turnServer = validateAddress(turnServer);
    this.useIpv4 = useIpv4;
    this.useIpv6 = useIpv6;
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
  }

  // 4.1.1 Gathering Candidates
  async gatherCandidates(cb?: (candidate: Candidate) => void) {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;
      this.promiseGatherCandidates = new Event();

      let address = getHostAddresses(this.useIpv4, this.useIpv6);
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

      const candidates = await this.getCandidates(address, 5, cb);
      this.localCandidates = [...this.localCandidates, ...candidates];

      this._localCandidatesEnd = true;
      this.promiseGatherCandidates.execute();
    }
    this.setState("completed");
  }

  private async getCandidates(
    addresses: string[],
    timeout = 5,
    cb?: (candidate: Candidate) => void,
  ) {
    let candidates: Candidate[] = [];

    await Promise.allSettled(
      addresses.map(async (address) => {
        // # create transport
        const protocol = new StunProtocol(this);
        try {
          await protocol.connectionMade(
            isIPv4(address),
            this.options.portRange,
            this.options.interfaceAddresses,
          );
        } catch (error) {
          log("protocol STUN", error);
          return;
        }

        protocol.localAddress = address;
        this.protocols.push(protocol);

        // # add host candidate
        const candidateAddress: Address = [address, protocol.getExtraInfo()[1]];

        protocol.localCandidate = new Candidate(
          candidateFoundation("host", "udp", candidateAddress[0]),
          1,
          "udp",
          candidatePriority(1, "host"),
          candidateAddress[0],
          candidateAddress[1],
          "host",
        );

        candidates.push(protocol.localCandidate);
        if (cb) {
          cb(protocol.localCandidate);
        }
      }),
    );

    let candidatePromises: Promise<Candidate | void>[] = [];

    // # query STUN server for server-reflexive candidates (IPv4 only)
    const { stunServer, turnServer } = this;
    if (stunServer) {
      const stunPromises = this.protocols.map((protocol) =>
        new Promise<Candidate | void>(async (r, f) => {
          const timer = setTimeout(f, timeout * 1000);
          if (
            protocol.localCandidate?.host &&
            isIPv4(protocol.localCandidate?.host)
          ) {
            const candidate = await serverReflexiveCandidate(
              protocol,
              stunServer,
            ).catch((error) => log("error", error));
            if (candidate && cb) cb(candidate);

            clearTimeout(timer);
            r(candidate);
          } else {
            clearTimeout(timer);
            r();
          }
        }).catch((error) => {
          log("query STUN server", error);
        }),
      );
      candidatePromises.push(...stunPromises);
    }

    const { turnUsername, turnPassword } = this.options;
    if (turnServer && turnUsername && turnPassword) {
      const turnCandidate = (async () => {
        const protocol = await createTurnEndpoint(
          turnServer,
          turnUsername,
          turnPassword,
          {
            portRange: this.options.portRange,
            interfaceAddresses: this.options.interfaceAddresses,
          },
        );
        this.protocols.push(protocol);

        const candidateAddress = protocol.turn.relayedAddress;
        const relatedAddress = protocol.turn.mappedAddress;

        log("turn candidateAddress", candidateAddress);

        protocol.localCandidate = new Candidate(
          candidateFoundation("relay", "udp", candidateAddress[0]),
          1,
          "udp",
          candidatePriority(1, "relay"),
          candidateAddress[0],
          candidateAddress[1],
          "relay",
          relatedAddress[0],
          relatedAddress[1],
        );
        if (cb) {
          cb(protocol.localCandidate);
        }
        protocol.receiver = this;
        return protocol.localCandidate;
      })().catch((error) => {
        log("query TURN server", error);
      });

      if (this.options.forceTurn) {
        candidates = [];
        candidatePromises = [];
      }

      candidatePromises.push(turnCandidate);
    }

    const extraCandidates = [...(await Promise.allSettled(candidatePromises))]
      .filter(
        (
          v,
        ): v is PromiseFulfilledResult<
          Awaited<(typeof candidatePromises)[number]>
        > => v.status === "fulfilled",
      )
      .map((v) => v.value)
      .filter((v): v is Candidate => typeof v !== "undefined");

    candidates.push(...extraCandidates);

    return candidates;
  }

  async connect() {
    // """
    // Perform ICE handshake.
    //
    // This coroutine returns if a candidate pair was successfully nominated
    // and raises an exception otherwise.
    // """
    log("start connect ice", this.localCandidates);
    if (!this._localCandidatesEnd) {
      if (!this.localCandidatesStart)
        throw new Error("Local candidates gathering was not performed");
      if (this.promiseGatherCandidates)
        // wait for GatherCandidates finish
        await this.promiseGatherCandidates.asPromise();
    }
    if (!this.remoteUsername || !this.remotePassword)
      throw new Error("Remote username or password is missing");

    // # 5.7.1. Forming Candidate Pairs
    this.remoteCandidates.forEach(this.pairRemoteCandidate);
    this.sortCheckList();

    this.unfreezeInitial();

    // # handle early checks
    this.earlyChecks.forEach((earlyCheck) => this.checkIncoming(...earlyCheck));
    this.earlyChecks = [];

    // # perform checks
    // 5.8.  Scheduling Checks
    for (;;) {
      if (this.state === "closed") break;
      if (!this.schedulingChecks()) break;
      await timers.setTimeout(20);
    }

    // # wait for completion
    let res: number = ICE_FAILED;
    while (this.checkList.length > 0 && res === ICE_FAILED) {
      res = await this.checkListState.get();
    }

    // # cancel remaining checks
    this.checkList.forEach((check) => check.handle?.cancel());

    if (res !== ICE_COMPLETED) {
      throw new Error("ICE negotiation failed");
    }

    // # start consent freshness tests
    this.queryConsentHandle = future(this.queryConsent());

    this.setState("connected");
  }

  private unfreezeInitial() {
    // # unfreeze first pair for the first component
    const [firstPair] = this.checkList;
    if (!firstPair) return;
    if (firstPair.state === CandidatePairState.FROZEN) {
      this.setPairState(firstPair, CandidatePairState.WAITING);
    }

    // # unfreeze pairs with same component but different foundations
    const seenFoundations = new Set(firstPair.localCandidate.foundation);
    for (const pair of this.checkList) {
      if (
        pair.component === firstPair.component &&
        !seenFoundations.has(pair.localCandidate.foundation) &&
        pair.state === CandidatePairState.FROZEN
      ) {
        this.setPairState(pair, CandidatePairState.WAITING);
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
          if (this.options.forceTurn && pair.protocol.type === "stun")
            return false;
          return true;
        })
        .find((pair) => pair.state === CandidatePairState.WAITING);
      if (pair) {
        pair.handle = future(this.checkStart(pair));
        return true;
      }
    }

    {
      // # find the highest-priority pair that is in the frozen state
      const pair = this.checkList.find(
        (pair) => pair.state === CandidatePairState.FROZEN,
      );
      if (pair) {
        pair.handle = future(this.checkStart(pair));
        return true;
      }
    }

    // # if we expect more candidates, keep going
    if (!this.remoteCandidatesEnd) {
      return !this.checkListDone;
    }

    return false;
  }

  // 4.1.1.4 ? 生存確認 life check
  private queryConsent = () =>
    new PCancelable(async (r, f, onCancel) => {
      let failures = 0;

      const cancelEvent = new AbortController();
      onCancel(() => {
        failures += CONSENT_FAILURES;
        cancelEvent.abort();
        f("cancel");
      });

      // """
      // Periodically check consent (RFC 7675).
      // """

      try {
        while (!this.remoteIsLite && this.state !== "closed") {
          // # randomize between 0.8 and 1.2 times CONSENT_INTERVAL
          await timers.setTimeout(
            CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000,
            undefined,
            { signal: cancelEvent.signal },
          );

          const pair = this.nominated;
          if (!pair) {
            break;
          }
          const request = this.buildRequest(pair, false);
          try {
            const [msg, addr] = await pair.protocol.request(
              request,
              pair.remoteAddr,
              Buffer.from(this.remotePassword, "utf8"),
              0,
            );
            failures = 0;
            if (this.state === "disconnected") {
              this.setState("connected");
            }
          } catch (error) {
            log("no stun response");
            failures++;
            this.setState("disconnected");
          }
          if (failures >= CONSENT_FAILURES) {
            log("Consent to send expired");
            this.queryConsentHandle = undefined;
            // 切断検知
            r(await this.close());
            return;
          }
        }
      } catch (error) {}
    });

  async close() {
    // """
    // Close the connection.
    // """

    this.setState("closed");

    // # stop consent freshness tests
    if (this.queryConsentHandle && !this.queryConsentHandle.done()) {
      this.queryConsentHandle.cancel();
      try {
        await this.queryConsentHandle.promise;
      } catch (error) {
        // pass
      }
    }

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

    await this.lookup?.close();
  }

  private setState(state: IceState) {
    this.state = state;
    this.stateChanged.execute(state);
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
        if (this.state === "closed") return;
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
    this.remoteCandidates.push(remoteCandidate);

    this.pairRemoteCandidate(remoteCandidate);
    this.sortCheckList();
  }

  send = async (data: Buffer) => {
    // """
    // Send a datagram on the first component.

    // If the connection is not established, a `ConnectionError` is raised.

    // :param data: The data to be sent.
    // """
    await this.sendTo(data);
  };

  private async sendTo(data: Buffer) {
    // """
    // Send a datagram on the specified component.

    // If the connection is not established, a `ConnectionError` is raised.

    // :param data: The data to be sent.
    // :param component: The component on which to send the data.
    // """
    const activePair = this.nominated;
    if (activePair) {
      await activePair.protocol.sendData(data, activePair.remoteAddr);
    } else {
      // log("Cannot send data, ice not connected");
      return;
    }
  }

  getDefaultCandidate() {
    const candidates = this.localCandidates.sort(
      (a, b) => a.priority - b.priority,
    );
    const [candidate] = candidates;
    return candidate;
  }

  requestReceived(
    message: Message,
    addr: Address,
    protocol: Protocol,
    rawData: Buffer,
  ) {
    if (message.messageMethod !== methods.BINDING) {
      this.respondError(message, addr, protocol, [400, "Bad Request"]);
      return;
    }

    // # authenticate request
    try {
      parseMessage(rawData, Buffer.from(this.localPassword, "utf8"));
      if (!this.remoteUsername) {
        const rxUsername = `${this.localUserName}:${this.remoteUsername}`;
        if (message.getAttributeValue("USERNAME") != rxUsername) {
          throw new Error("Wrong username");
        }
      }
    } catch (error) {
      this.respondError(message, addr, protocol, [400, "Bad Request"]);
      return;
    }

    const { iceControlling } = this;

    // 7.2.1.1.  Detecting and Repairing Role Conflicts
    if (iceControlling && message.attributesKeys.includes("ICE-CONTROLLING")) {
      if (this._tieBreaker >= message.getAttributeValue("ICE-CONTROLLING")) {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
        return;
      } else {
        this.switchRole(false);
      }
    } else if (
      !iceControlling &&
      message.attributesKeys.includes("ICE-CONTROLLED")
    ) {
      if (this._tieBreaker < message.getAttributeValue("ICE-CONTROLLED")) {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
      } else {
        this.switchRole(true);
        return;
      }
    }

    if (
      this.options.filterStunResponse &&
      !this.options.filterStunResponse(message, addr, protocol)
    ) {
      return;
    }

    // # send binding response
    const response = new Message(
      methods.BINDING,
      classes.RESPONSE,
      message.transactionId,
    );
    response
      .setAttribute("XOR-MAPPED-ADDRESS", addr)
      .addMessageIntegrity(Buffer.from(this.localPassword, "utf8"))
      .addFingerprint();
    protocol.sendStun(response, addr).catch((e) => {
      log("sendStun error", e);
    });

    // todo fix
    // if (this.checkList.length === 0) {
    //   this.earlyChecks.push([message, addr, protocol]);
    // } else {
    this.checkIncoming(message, addr, protocol);
    // }
  }

  dataReceived(data: Buffer, component: number) {
    try {
      this.onData.execute(data, component);
    } catch (error) {
      log("dataReceived", error);
    }
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
      this.remoteCandidates.push(remoteCandidate);
    }

    this.remoteCandidatesEnd = true;
  }
  get remoteCandidates() {
    return this._remoteCandidates;
  }

  private sortCheckList() {
    sortCandidatePairs(this.checkList, this.iceControlling);
  }

  private findPair(protocol: Protocol, remoteCandidate: Candidate) {
    const pair = this.checkList.find(
      (pair) =>
        isEqual(pair.protocol, protocol) &&
        isEqual(pair.remoteCandidate, remoteCandidate),
    );
    return pair;
  }

  private setPairState(pair: CandidatePair, state: CandidatePairState) {
    log("setPairState", pair.toJSON(), CandidatePairState[state]);
    pair.updateState(state);
  }

  private switchRole(iceControlling: boolean) {
    log("switch role", iceControlling);
    this.iceControlling = iceControlling;
    this.sortCheckList();
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.nominating = false;
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      // Updating the Nominated Flag

      // https://www.rfc-editor.org/rfc/rfc8445#section-7.3.1.5,
      // Once the nominated flag is set for a component of a data stream, it
      // concludes the ICE processing for that component.  See Section 8.
      // So disallow overwriting of the pair nominated for that component
      if (pair.nominated && this.nominated == undefined) {
        log("nominated", pair.toJSON());
        this.nominated = pair;
        this.nominating = false;

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
            this.setPairState(p, CandidatePairState.FAILED);
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

      // 7.1.3.2.3.  Updating Pair States
      for (const p of this.checkList) {
        if (
          p.localCandidate.foundation === pair.localCandidate.foundation &&
          p.state === CandidatePairState.FROZEN
        ) {
          this.setPairState(p, CandidatePairState.WAITING);
        }
      }
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
    new PCancelable(async (r, f, onCancel) => {
      onCancel(() => f("cancel"));

      // """
      // Starts a check.
      // """

      log("check start", pair.toJSON());

      this.setPairState(pair, CandidatePairState.IN_PROGRESS);

      const nominate = this.iceControlling && !this.remoteIsLite;
      const request = this.buildRequest(pair, nominate);

      const result: { response?: Message; addr?: Address } = {};
      try {
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(this.remotePassword, "utf8"),
          4,
        );
        log("response", response, addr);
        result.response = response;
        result.addr = addr;
      } catch (error: any) {
        const exc: TransactionError = error;
        // 7.1.3.1.  Failure Cases
        log("failure case", exc.response);
        if (exc.response?.getAttributeValue("ERROR-CODE")[0] === 487) {
          if (request.attributesKeys.includes("ICE-CONTROLLED")) {
            this.switchRole(true);
          } else if (request.attributesKeys.includes("ICE-CONTROLLING")) {
            this.switchRole(false);
          }
          await this.checkStart(pair);
          r();
          return;
        } else {
          // timeout
          log("CandidatePairState.FAILED", pair.toJSON());
          this.setPairState(pair, CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
      }

      // # check remote address matches
      if (!isEqual(result.addr, pair.remoteAddr)) {
        this.setPairState(pair, CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // # success
      if (nominate || pair.remoteNominated) {
        // # nominated by agressive nomination or the remote party
        pair.nominated = true;
      } else if (this.iceControlling && !this.nominating) {
        // # perform regular nomination
        this.nominating = true;
        const request = this.buildRequest(pair, true);
        try {
          await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8"),
          );
        } catch (error) {
          this.setPairState(pair, CandidatePairState.FAILED);
          this.checkComplete(pair);
          return;
        }
        pair.nominated = true;
      }

      this.setPairState(pair, CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: Protocol) {
    // log("checkIncoming", message.toJSON(), addr);
    // """
    // Handle a successful incoming check.
    // """

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
        "udp",
        message.getAttributeValue("PRIORITY"),
        host,
        port,
        "prflx",
      );
      this.remoteCandidates.push(remoteCandidate);
    }

    // find pair
    let pair = this.findPair(protocol, remoteCandidate);
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate);
      this.setPairState(pair, CandidatePairState.WAITING);
      this.checkList.push(pair);
      this.sortCheckList();
    }

    // 7.2.1.4.  Triggered Checks
    if (
      [CandidatePairState.WAITING, CandidatePairState.FAILED].includes(
        pair.state,
      )
    ) {
      pair.handle = future(this.checkStart(pair));
    } else {
      pair;
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

  private pairRemoteCandidate = (remoteCandidate: Candidate) => {
    for (const protocol of this.protocols) {
      if (
        protocol.localCandidate?.canPairWith(remoteCandidate) &&
        !this.findPair(protocol, remoteCandidate)
      ) {
        const pair = new CandidatePair(protocol, remoteCandidate);
        if (
          this.options.filterCandidatePair &&
          !this.options.filterCandidatePair(pair)
        ) {
          continue;
        }
        this.checkList.push(pair);
        this.setPairState(pair, CandidatePairState.WAITING);
      }
    }
  };

  private buildRequest(pair: CandidatePair, nominate: boolean) {
    const txUsername = `${this.remoteUsername}:${this.localUserName}`;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", txUsername)
      .setAttribute("PRIORITY", candidatePriority(pair.component, "prflx"));
    if (this.iceControlling) {
      request.setAttribute("ICE-CONTROLLING", this._tieBreaker);
      if (nominate) {
        request.setAttribute("USE-CANDIDATE", null);
      }
    } else {
      request.setAttribute("ICE-CONTROLLED", this._tieBreaker);
    }
    return request;
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

export class CandidatePair {
  handle?: Future;
  nominated = false;
  remoteNominated = false;
  // 5.7.4.  Computing States
  private _state = CandidatePairState.FROZEN;
  get state() {
    return this._state;
  }

  toJSON() {
    return {
      protocol: this.protocol.type,
      remoteAddr: this.remoteAddr,
    };
  }

  constructor(public protocol: Protocol, public remoteCandidate: Candidate) {}

  updateState(state: CandidatePairState) {
    this._state = state;
  }

  get localCandidate() {
    if (!this.protocol.localCandidate)
      throw new Error("localCandidate not exist");
    return this.protocol.localCandidate;
  }

  get remoteAddr(): Address {
    return [this.remoteCandidate.host, this.remoteCandidate.port];
  }

  get component() {
    return this.localCandidate.component;
  }
}

const ICE_COMPLETED = 1 as const;
const ICE_FAILED = 2 as const;

const CONSENT_INTERVAL = 5;
const CONSENT_FAILURES = 6;

export enum CandidatePairState {
  FROZEN = 0,
  WAITING = 1,
  IN_PROGRESS = 2,
  SUCCEEDED = 3,
  FAILED = 4,
}

type IceState = "disconnected" | "closed" | "completed" | "new" | "connected";

export interface IceOptions {
  stunServer?: Address;
  turnServer?: Address;
  turnUsername?: string;
  turnPassword?: string;
  turnSsl?: boolean;
  turnTransport?: string;
  forceTurn?: boolean;
  useIpv4: boolean;
  useIpv6: boolean;
  portRange?: [number, number];
  interfaceAddresses?: InterfaceAddresses;
  additionalHostAddresses?: string[];
  filterStunResponse?: (
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) => boolean;
  filterCandidatePair?: (pair: CandidatePair) => boolean;
}

const defaultOptions: IceOptions = {
  useIpv4: true,
  useIpv6: true,
};

export function validateRemoteCandidate(candidate: Candidate) {
  // """
  // Check the remote candidate is supported.
  // """
  if (!["host", "relay", "srflx"].includes(candidate.type))
    throw new Error(`Unexpected candidate type "${candidate.type}"`);

  // ipaddress.ip_address(candidate.host)
  return candidate;
}

export function sortCandidatePairs(
  pairs: CandidatePair[],
  iceControlling: boolean,
) {
  pairs.sort(
    (a, b) =>
      candidatePairPriority(
        a.localCandidate,
        a.remoteCandidate,
        iceControlling,
      ) -
      candidatePairPriority(
        b.localCandidate,
        b.remoteCandidate,
        iceControlling,
      ),
  );
}

// 5.7.2.  Computing Pair Priority and Ordering Pairs
export function candidatePairPriority(
  local: Candidate,
  remote: Candidate,
  iceControlling: boolean,
) {
  const G = (iceControlling && local.priority) || remote.priority;
  const D = (iceControlling && remote.priority) || local.priority;
  return (1 << 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
}

export async function serverReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address,
) {
  // """
  // Query STUN server to obtain a server-reflexive candidate.
  // """

  // # perform STUN query
  const request = new Message(methods.BINDING, classes.REQUEST);
  try {
    const [response] = await protocol.request(request, stunServer);

    const localCandidate = protocol.localCandidate;
    if (!localCandidate) throw new Error("not exist");

    return new Candidate(
      candidateFoundation("srflx", "udp", localCandidate.host),
      localCandidate.component,
      localCandidate.transport,
      candidatePriority(localCandidate.component, "srflx"),
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[0],
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[1],
      "srflx",
      localCandidate.host,
      localCandidate.port,
    );
  } catch (error) {
    // todo fix
    log("error serverReflexiveCandidate", error);
  }
}

export function validateAddress(addr?: Address): Address | undefined {
  if (addr && Number.isNaN(addr[1])) {
    return [addr[0], 443];
  }
  return addr;
}
