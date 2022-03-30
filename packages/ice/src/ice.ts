import { randomBytes } from "crypto";
import debug from "debug";
import dns from "dns";
import { Uint64BE } from "int64-buffer";
import * as nodeIp from "ip";
import range from "lodash/range";
import isEqual from "lodash/isEqual";
import { isIPv4 } from "net";
import PCancelable from "p-cancelable";
import { Event } from "rx.mini";
import timers from "timers/promises";
import util from "util";

import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import { TransactionError } from "./exceptions";
import { difference, Future, future, PQueue, randomString } from "./helper";
import { classes, methods } from "./stun/const";
import { Message, parseMessage } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { createTurnEndpoint } from "./turn/protocol";
import { Address, Protocol } from "./types/model";

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
  _components: Set<number>;
  _localCandidatesEnd = false;
  _tieBreaker: BigInt = BigInt(new Uint64BE(randomBytes(64)).toString());
  state: IceState = "new";

  readonly onData = new Event<[Buffer, number]>();
  readonly stateChanged = new Event<[IceState]>();

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  private nominated: { [key: number]: CandidatePair } = {};
  get nominatedKeys() {
    return Object.keys(this.nominated).map((v) => v.toString());
  }
  private nominating = new Set<number>();
  get remoteAddr() {
    return Object.values(this.nominated)[0].remoteAddr;
  }
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
    const { components, stunServer, turnServer, useIpv4, useIpv6 } =
      this.options;
    this.stunServer = validateAddress(stunServer);
    this.turnServer = validateAddress(turnServer);
    this.useIpv4 = useIpv4;
    this.useIpv6 = useIpv6;
    this._components = new Set(range(1, components + 1));
  }

  // 4.1.1 Gathering Candidates
  async gatherCandidates(cb?: (candidate: Candidate) => void) {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;
      this.promiseGatherCandidates = new Event();

      const address = getHostAddress(this.useIpv4, this.useIpv6);
      for (const component of this._components) {
        const candidates = await this.getComponentCandidates(
          component,
          address,
          5,
          cb
        );
        this.localCandidates = [...this.localCandidates, ...candidates];
      }

      this._localCandidatesEnd = true;
      this.promiseGatherCandidates.execute();
    }
    this.setState("completed");
  }

  private async getComponentCandidates(
    component: number,
    addresses: string[],
    timeout = 5,
    cb?: (candidate: Candidate) => void
  ) {
    let candidates: Candidate[] = [];

    for (const address of addresses) {
      // # create transport
      const protocol = new StunProtocol(this);
      await protocol.connectionMade(isIPv4(address), this.options.portRange);
      protocol.localAddress = address;
      this.protocols.push(protocol);

      // # add host candidate
      const candidateAddress: Address = [address, protocol.getExtraInfo()[1]];

      protocol.localCandidate = new Candidate(
        candidateFoundation("host", "udp", candidateAddress[0]),
        component,
        "udp",
        candidatePriority(component, "host"),
        candidateAddress[0],
        candidateAddress[1],
        "host"
      );

      candidates.push(protocol.localCandidate);
      if (cb) cb(protocol.localCandidate);
    }

    // # query STUN server for server-reflexive candidates (IPv4 only)
    const stunServer = this.stunServer;
    if (stunServer) {
      try {
        const srflxCandidates = (
          await Promise.all<Candidate | void>(
            this.protocols.map(
              (protocol) =>
                new Promise(async (r, f) => {
                  const timer = setTimeout(f, timeout * 1000);
                  if (
                    protocol.localCandidate?.host &&
                    isIPv4(protocol.localCandidate?.host)
                  ) {
                    const candidate = await serverReflexiveCandidate(
                      protocol,
                      stunServer
                    ).catch((error) => log("error", error));
                    if (candidate && cb) cb(candidate);

                    clearTimeout(timer);
                    r(candidate);
                  } else {
                    clearTimeout(timer);
                    r();
                  }
                })
            )
          )
        ).filter((v): v is Candidate => typeof v !== "undefined");
        candidates = [...candidates, ...srflxCandidates];
      } catch (error) {
        log("query STUN server", error);
      }
    }

    if (
      this.turnServer &&
      this.options.turnUsername &&
      this.options.turnPassword
    ) {
      const protocol = await createTurnEndpoint(
        this.turnServer,
        this.options.turnUsername,
        this.options.turnPassword,
        { portRange: this.options.portRange }
      );
      this.protocols.push(protocol);

      const candidateAddress = protocol.turn.relayedAddress;
      const relatedAddress = protocol.turn.mappedAddress;

      log("turn candidateAddress", candidateAddress);

      protocol.localCandidate = new Candidate(
        candidateFoundation("relay", "udp", candidateAddress[0]),
        component,
        "udp",
        candidatePriority(component, "relay"),
        candidateAddress[0],
        candidateAddress[1],
        "relay",
        relatedAddress[0],
        relatedAddress[1]
      );
      protocol.receiver = this;

      if (this.options.forceTurn) {
        candidates = [];
      }

      candidates.push(protocol.localCandidate);
    }

    return candidates;
  }

  async connect() {
    // """
    // Perform ICE handshake.
    //
    // This coroutine returns if a candidate pair was successfully nominated
    // and raises an exception otherwise.
    // """
    log("start connect ice");
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
      if (!this.schedulingChecks()) break;
      await timers.setTimeout(20);
    }

    // # wait for completion
    const res: number =
      this.checkList.length > 0 ? await this.checkListState.get() : ICE_FAILED;

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
    const firstPair = this.checkList.find(
      (pair) => pair.component === Math.min(...[...this._components])
    );
    if (!firstPair) return;
    if (firstPair.state === CandidatePairState.FROZEN) {
      this.checkState(firstPair, CandidatePairState.WAITING);
    }

    // # unfreeze pairs with same component but different foundations
    const seenFoundations = new Set(firstPair.localCandidate.foundation);
    for (const pair of this.checkList) {
      if (
        pair.component === firstPair.component &&
        !seenFoundations.has(pair.localCandidate.foundation) &&
        pair.state === CandidatePairState.FROZEN
      ) {
        this.checkState(pair, CandidatePairState.WAITING);
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
        (pair) => pair.state === CandidatePairState.FROZEN
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
            { signal: cancelEvent.signal }
          );

          for (const key of this.nominatedKeys) {
            const pair = this.nominated[Number(key)];
            const request = this.buildRequest(pair, false);
            try {
              const [msg, addr] = await pair.protocol.request(
                request,
                pair.remoteAddr,
                Buffer.from(this.remotePassword, "utf8"),
                0
              );
              failures = 0;
              if (this.state === "disconnected") {
                this.setState("connected");
              }
            } catch (error) {
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
      this.checkListState.put(new Promise((r) => r(ICE_FAILED)));
    }

    this.nominated = {};
    for (const protocol of this.protocols) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];
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
    if (this.remoteCandidatesEnd)
      throw new Error("Cannot add remote candidate after end-of-candidates.");

    if (!remoteCandidate) {
      this.pruneComponents();
      this.remoteCandidatesEnd = true;
      return;
    }

    if (remoteCandidate.host.includes(".local")) {
      await timers.setTimeout(10);

      const res = await util
        .promisify(dns.lookup)(remoteCandidate.host)
        .catch((err) => {
          log(err, remoteCandidate);
        });
      if (res) {
        remoteCandidate.host = res.address;
      } else {
        // todo fix
        remoteCandidate.host = "127.0.0.1";
      }
    }

    try {
      validateRemoteCandidate(remoteCandidate);
    } catch (error) {
      return;
    }
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
    await this.sendTo(data, 1);
  };

  private async sendTo(data: Buffer, component: number) {
    // """
    // Send a datagram on the specified component.

    // If the connection is not established, a `ConnectionError` is raised.

    // :param data: The data to be sent.
    // :param component: The component on which to send the data.
    // """
    const activePair = this.nominated[component];
    if (activePair) {
      await activePair.protocol.sendData(data, activePair.remoteAddr);
    } else {
      throw new Error("Cannot send data, ice not connected");
    }
  }

  getDefaultCandidate(component: number) {
    const candidates = this.localCandidates.sort(
      (a, b) => a.priority - b.priority
    );
    const candidate = candidates.find(
      (candidate) => candidate.component === component
    );
    return candidate;
  }

  requestReceived(
    message: Message,
    addr: Address,
    protocol: Protocol,
    rawData: Buffer
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
        if (message.attributes["USERNAME"] != rxUsername)
          throw new Error("Wrong username");
      }
    } catch (error) {
      this.respondError(message, addr, protocol, [400, "Bad Request"]);
      return;
    }

    const { iceControlling } = this;

    // 7.2.1.1.  Detecting and Repairing Role Conflicts
    if (iceControlling && message.attributesKeys.includes("ICE-CONTROLLING")) {
      if (this._tieBreaker >= message.attributes["ICE-CONTROLLING"]) {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
        return;
      } else {
        this.switchRole(false);
      }
    } else if (
      !iceControlling &&
      message.attributesKeys.includes("ICE-CONTROLLED")
    ) {
      if (this._tieBreaker < message.attributes["ICE-CONTROLLED"]) {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
      } else {
        this.switchRole(true);
        return;
      }
    }

    // # send binding response
    const response = new Message(
      methods.BINDING,
      classes.RESPONSE,
      message.transactionId
    );
    response.attributes["XOR-MAPPED-ADDRESS"] = addr;
    response.addMessageIntegrity(Buffer.from(this.localPassword, "utf8"));
    response.addFingerprint();
    protocol.sendStun(response, addr);

    // todo fix
    // if (this.checkList.length === 0) {
    //   this.earlyChecks.push([message, addr, protocol]);
    // } else {
    this.checkIncoming(message, addr, protocol);
    // }
  }

  dataReceived(data: Buffer, component: number) {
    this.onData.execute(data, component);
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
    this.pruneComponents();
    this.remoteCandidatesEnd = true;
  }
  get remoteCandidates() {
    return this._remoteCandidates;
  }

  private pruneComponents() {
    const seenComponents = new Set(
      this.remoteCandidates.map((v) => v.component)
    );
    const missingComponents = [...difference(this._components, seenComponents)];
    if (missingComponents.length > 0) {
      this._components = seenComponents;
    }
  }

  private sortCheckList() {
    sortCandidatePairs(this.checkList, this.iceControlling);
  }

  private findPair(protocol: Protocol, remoteCandidate: Candidate) {
    const pair = this.checkList.find(
      (pair) =>
        isEqual(pair.protocol, protocol) &&
        isEqual(pair.remoteCandidate, remoteCandidate)
    );
    return pair;
  }

  private checkState(pair: CandidatePair, state: CandidatePairState) {
    pair.state = state;
  }

  private switchRole(iceControlling: boolean) {
    log("switch role", iceControlling);
    this.iceControlling = iceControlling;
    this.sortCheckList();
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      if (pair.nominated) {
        this.nominated[pair.component] = pair;

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream.
        for (const p of this.checkList) {
          if (
            p.component === pair.component &&
            [CandidatePairState.WAITING, CandidatePairState.FROZEN].includes(
              p.state
            )
          ) {
            this.checkState(p, CandidatePairState.FAILED);
          }
        }
      }

      // Once there is at least one nominated pair in the valid list for
      // every component of at least one media stream and the state of the
      // check list is Running:
      if (this.nominatedKeys.length === this._components.size) {
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
          this.checkState(p, CandidatePairState.WAITING);
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
      this.checkListState.put(new Promise((r) => r(ICE_FAILED)));
      this.checkListDone = true;
    }
  }

  // 3.  Terminology : Check
  checkStart = (pair: CandidatePair) =>
    new PCancelable(async (r, f, onCancel) => {
      onCancel(() => f("cancel"));

      // """
      // Starts a check.
      // """

      log("check start", pair.remoteCandidate);

      this.checkState(pair, CandidatePairState.IN_PROGRESS);

      const nominate = this.iceControlling && !this.remoteIsLite;
      const request = this.buildRequest(pair, nominate);

      const result: { response?: Message; addr?: Address } = {};
      try {
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(this.remotePassword, "utf8")
        );
        log("response", response, addr);
        result.response = response;
        result.addr = addr;
      } catch (error: any) {
        const exc: TransactionError = error;
        // 7.1.3.1.  Failure Cases
        log("failure case", exc.response);
        if (exc.response?.attributes["ERROR-CODE"][0] === 487) {
          if (request.attributesKeys.includes("ICE-CONTROLLED")) {
            this.switchRole(true);
          } else if (request.attributesKeys.includes("ICE-CONTROLLING")) {
            this.switchRole(false);
          }
          await this.checkStart(pair);
          r();
          return;
        } else {
          log("CandidatePairState.FAILED");
          this.checkState(pair, CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
      }

      // # check remote address matches
      if (!isEqual(result.addr, pair.remoteAddr)) {
        this.checkState(pair, CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // # success
      if (nominate || pair.remoteNominated) {
        // # nominated by agressive nomination or the remote party
        pair.nominated = true;
      } else if (this.iceControlling && !this.nominating.has(pair.component)) {
        // # perform regular nomination
        this.nominating.add(pair.component);
        const request = this.buildRequest(pair, true);
        try {
          await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8")
          );
        } catch (error) {
          this.checkState(pair, CandidatePairState.FAILED);
          this.checkComplete(pair);
          return;
        }
        pair.nominated = true;
      }

      this.checkState(pair, CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: Protocol) {
    // """
    // Handle a successful incoming check.
    // """
    const component = protocol.localCandidate?.component;
    if (component == undefined) throw new Error();

    // find remote candidate
    let remoteCandidate: Candidate | undefined;
    const [host, port] = addr;
    for (const c of this.remoteCandidates) {
      if (c.host === host && c.port === port) {
        remoteCandidate = c;
        if (remoteCandidate.component !== component)
          throw new Error("checkIncoming");
        break;
      }
    }
    if (!remoteCandidate) {
      // 7.2.1.3.  Learning Peer Reflexive Candidates
      remoteCandidate = new Candidate(
        randomString(10),
        component,
        "udp",
        message.attributes["PRIORITY"],
        host,
        port,
        "prflx"
      );
      this.remoteCandidates.push(remoteCandidate);
    }

    // find pair
    let pair = this.findPair(protocol, remoteCandidate);
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate);
      pair.state = CandidatePairState.WAITING;
      this.checkList.push(pair);
      this.sortCheckList();
    }

    // 7.2.1.4.  Triggered Checks
    if (
      [CandidatePairState.WAITING, CandidatePairState.FAILED].includes(
        pair.state
      )
    ) {
      pair.handle = future(this.checkStart(pair));
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
        this.checkList.push(pair);
      }
    }
  };

  private buildRequest(pair: CandidatePair, nominate: boolean) {
    const txUsername = `${this.remoteUsername}:${this.localUserName}`;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.attributes["USERNAME"] = txUsername;
    request.attributes["PRIORITY"] = candidatePriority(pair.component, "prflx");
    if (this.iceControlling) {
      request.attributes["ICE-CONTROLLING"] = this._tieBreaker;
      if (nominate) {
        request.attributes["USE-CANDIDATE"] = null;
      }
    } else {
      request.attributes["ICE-CONTROLLED"] = this._tieBreaker;
    }
    return request;
  }

  private respondError(
    request: Message,
    addr: Address,
    protocol: Protocol,
    errorCode: [number, string]
  ) {
    const response = new Message(
      request.messageMethod,
      classes.ERROR,
      request.transactionId
    );
    response.attributes["ERROR-CODE"] = errorCode;
    response.addMessageIntegrity(Buffer.from(this.localPassword, "utf8"));
    response.addFingerprint();
    protocol.sendStun(response, addr);
  }
}

export class CandidatePair {
  handle?: Future;
  nominated = false;
  remoteNominated = false;
  // 5.7.4.  Computing States
  state = CandidatePairState.FROZEN;

  constructor(public protocol: Protocol, public remoteCandidate: Candidate) {}

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
  components: number;
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
}

const defaultOptions: IceOptions = {
  components: 1,
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
  iceControlling: boolean
) {
  pairs.sort(
    (a, b) =>
      candidatePairPriority(
        a.localCandidate,
        a.remoteCandidate,
        iceControlling
      ) -
      candidatePairPriority(b.localCandidate, b.remoteCandidate, iceControlling)
  );
}

// 5.7.2.  Computing Pair Priority and Ordering Pairs
export function candidatePairPriority(
  local: Candidate,
  remote: Candidate,
  iceControlling: boolean
) {
  const G = (iceControlling && local.priority) || remote.priority;
  const D = (iceControlling && remote.priority) || local.priority;
  return (1 << 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
}

export function getHostAddress(useIpv4: boolean, useIpv6: boolean) {
  const address: string[] = [];
  if (useIpv4) address.push(nodeIp.address("", "ipv4"));
  if (useIpv6) address.push(nodeIp.address("", "ipv6"));
  return address;
}

export async function serverReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address
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
      response.attributes["XOR-MAPPED-ADDRESS"][0],
      response.attributes["XOR-MAPPED-ADDRESS"][1],
      "srflx",
      localCandidate.host,
      localCandidate.port
    );
  } catch (error) {
    // todo fix
    log("error serverReflexiveCandidate", error);
  }
}

export function validateAddress(addr?: Address): Address | undefined {
  if (addr && isNaN(addr[1])) {
    return [addr[0], 443];
  }
  return addr;
}
