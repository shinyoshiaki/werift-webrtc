import {
  difference,
  randomString,
  PQueue,
  sleep,
  Future,
  future,
} from "../utils";
import { range } from "lodash";
import { Message, methods, classes, parseMessage } from "../stun/stun";
import { Address, Protocol } from "../model";
import {
  Candidate,
  candidatePriority,
  candidateFoundation,
} from "../candidate";
import { randomBytes } from "crypto";
import { TransactionError } from "../exceptions";
import * as nodeIp from "ip";
import { StunProtocol } from "./protocol";
import { isIPv4 } from "net";
import { isEqual } from "lodash";
import PCancelable from "p-cancelable";
import { Subject } from "rxjs";
import { Uint64BE } from "int64-buffer";

const ICE_COMPLETED = 1;
const ICE_FAILED = 2;
const CONSENT_FAILURES = 6;
const CONSENT_INTERVAL = 5;

function validateRemoteCandidate(candidate: Candidate) {
  // """
  // Check the remote candidate is supported.

  // mDNS candidates are not supported yet.
  // """
  if (!["host", "relay", "srflx"].includes(candidate.type))
    throw new Error(`Unexpected candidate type "${candidate.type}"`);

  // TODO check mDNS
  // ipaddress.ip_address(candidate.host)
  return candidate;
}

function sortCandidatePairs(pairs: CandidatePair[], iceControlling: boolean) {
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
function candidatePairPriority(
  local: Candidate,
  remote: Candidate,
  iceControlling: boolean
) {
  const G = (iceControlling && local.priority) || remote.priority;
  const D = (iceControlling && remote.priority) || local.priority;
  return (1 << 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
}

export function getHostAddress(useIpv4: boolean, useIpv6: boolean) {
  const address = [];
  if (useIpv4) address.push(nodeIp.address("", "ipv4"));
  if (useIpv6) address.push(nodeIp.address("", "ipv6"));
  return address;
}

async function serverReflexiveCandidate(
  protocol: StunProtocol,
  stunServer: Address
) {
  // """
  // Query STUN server to obtain a server-reflexive candidate.
  // """

  // # perform STUN query
  const request = new Message(methods.BINDING, classes.REQUEST);
  const [response] = await protocol.request(request, stunServer);

  const localCandidate = protocol.localCandidate!;
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
}

export enum CandidatePairState {
  FROZEN = 0,
  WAITING = 1,
  IN_PROGRESS = 2,
  SUCCEEDED = 3,
  FAILED = 4,
}

export class CandidatePair {
  handle?: Future;
  nominated = false;
  remoteNominated = false;
  // 5.7.4.  Computing States
  state = CandidatePairState.FROZEN;

  constructor(
    public protocol: StunProtocol,
    public remoteCandidate: Candidate
  ) {}

  get localCandidate() {
    return this.protocol.localCandidate!;
  }

  get remoteAddr(): [string, number] {
    return [this.remoteCandidate.host, this.remoteCandidate.port];
  }

  get component() {
    return this.localCandidate.component;
  }
}

export type Options = {
  components: number;
  stunServer?: Address;
  useIpv4: boolean;
  useIpv6: boolean;
  log: boolean;
};

const defaultOptions: Options = {
  components: 1,
  stunServer: undefined,
  useIpv4: true,
  useIpv6: true,
  log: false,
};

export class Connection {
  remotePassword: string = "";
  remoteUsername: string = "";
  localUserName = randomString(4);
  localPassword = randomString(22);
  checkList: CandidatePair[] = [];
  localCandidates: Candidate[] = [];
  stunServer?: Address;
  useIpv4: boolean;
  useIpv6: boolean;
  options: Options;
  onData = new Subject<Buffer>();
  remoteCandidatesEnd = false;

  private remoteCandidates_: Candidate[] = [];

  // P2P接続完了したソケット
  private nominated: { [key: number]: CandidatePair } = {};
  get nominatedKeys() {
    return Object.keys(this.nominated).map((v) => v.toString());
  }
  get socket() {
    return Object.values(this.nominated)[0].protocol.socket;
  }
  get remoteAddr() {
    return Object.values(this.nominated)[0].remoteAddr;
  }
  private checkListDone = false;
  private checkListState = new PQueue();
  private earlyChecks: [Message, Address, StunProtocol][] = [];
  private localCandidatesStart = false;
  private protocols: StunProtocol[] = [];
  private queryConsentHandle?: Future;
  private dataQueue = new PQueue<[Buffer, number]>();
  _components: Set<number>;
  _localCandidatesEnd = false;
  _tieBreaker: BigInt = BigInt(new Uint64BE(randomBytes(64)).toNumber());

  constructor(public iceControlling: boolean, options?: Partial<Options>) {
    this.options = {
      ...defaultOptions,
      ...options,
    };
    const { components, stunServer, useIpv4, useIpv6 } = this.options;
    this.stunServer = stunServer;
    this.useIpv4 = useIpv4;
    this.useIpv6 = useIpv6;
    this._components = new Set(range(1, components + 1));
  }

  private log(...args: any[]) {
    if (this.options.log) {
      console.log(...args);
    }
  }

  set remoteCandidates(value: Candidate[]) {
    if (this.remoteCandidatesEnd)
      throw new Error("Cannot set remote candidates after end-of-candidates.");
    this.remoteCandidates_ = [];
    for (let remoteCandidate of value) {
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
    return this.remoteCandidates_;
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

  sortCheckList() {
    sortCandidatePairs(this.checkList, this.iceControlling);
  }

  dataReceived(data: Buffer, component: number) {
    this.log("dataReceived", data, component);
    this.dataQueue.put(new Promise((r) => r([data, component])));

    // data stream
    this.onData.next(data);
  }

  private findPair(protocol: Protocol, remoteCandidate: Candidate) {
    const pair = this.checkList.find(
      (pair) =>
        isEqual(pair.protocol, protocol) &&
        isEqual(pair.remoteCandidate, remoteCandidate)
    );
    return pair;
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

  checkState(pair: CandidatePair, state: CandidatePairState) {
    pair.state = state;
  }

  buildRequest(pair: CandidatePair) {
    const txUsername = `${this.remoteUsername}:${this.localUserName}`;
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.attributes["USERNAME"] = txUsername;
    request.attributes["PRIORITY"] = candidatePriority(pair.component, "prflx");
    if (this.iceControlling) {
      request.attributes["ICE-CONTROLLING"] = this._tieBreaker;
      request.attributes["USE-CANDIDATE"] = null;
    } else {
      request.attributes["ICE-CONTROLLED"] = this._tieBreaker;
    }
    return request;
  }

  switchRole(iceControlling: boolean) {
    this.iceControlling = iceControlling;
    this.sortCheckList();
  }

  checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      if (pair.nominated) {
        this.nominated[pair.component] = pair;

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream.
        for (let p of this.checkList) {
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
          this.log("ICE completed");
          this.checkListState.put(new Promise((r) => r(ICE_COMPLETED)));
          this.checkListDone = true;
        }
        return;
      }

      // 7.1.3.2.3.  Updating Pair States
      for (let p of this.checkList) {
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
      this.log("ICE failed");
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

      this.checkState(pair, CandidatePairState.IN_PROGRESS);
      const request = this.buildRequest(pair);

      const result: { response?: Message; addr?: Address } = {};
      try {
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(this.remotePassword, "utf8")
        );
        result.response = response;
        result.addr = addr;
      } catch (error) {
        const exc: TransactionError = error;
        // 7.1.3.1.  Failure Cases
        if (exc.response?.attributes["ERROR-CODE"][0] === 487) {
          if (request.attributesKeys.includes("ICE-CONTROLLED")) {
            this.switchRole(true);
          } else if (request.attributesKeys.includes("ICE-CONTROLLING")) {
            this.switchRole(false);
          }
          r(await this.checkStart(pair));
          return;
        } else {
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
      this.checkState(pair, CandidatePairState.SUCCEEDED);
      if (this.iceControlling || pair.remoteNominated) {
        pair.nominated = true;
      }
      this.checkComplete(pair);
      r();
    });

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: StunProtocol) {
    // """
    // Handle a successful incoming check.
    // """
    const component = protocol.localCandidate?.component!;

    // find remote candidate
    let remoteCandidate: Candidate | undefined;
    const [host, port] = addr;
    for (let c of this.remoteCandidates) {
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

  addRemoteCandidate(remoteCandidate: Candidate | undefined) {
    // """
    // Add a remote candidate or signal end-of-candidates.

    // To signal end-of-candidates, pass `None`.

    // :param remote_candidate: A :class:`Candidate` instance or `None`.
    // """
    if (this.remoteCandidatesEnd) {
      throw new Error("Cannot add remote candidate after end-of-candidates.");
    }

    if (!remoteCandidate) {
      this.pruneComponents();
      this.remoteCandidatesEnd = true;
      return;
    }

    try {
      validateRemoteCandidate(remoteCandidate);
    } catch (error) {
      return;
    }
    this.remoteCandidates.push(remoteCandidate);

    for (let protocol of this.protocols) {
      if (
        protocol.localCandidate?.canPairWith(remoteCandidate) &&
        !this.findPair(protocol, remoteCandidate)
      ) {
        const pair = new CandidatePair(protocol, remoteCandidate);
        this.checkList.push(pair);
      }
      this.sortCheckList();
    }
  }

  respondError(
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

  requestReceived(
    message: Message,
    addr: Address,
    protocol: StunProtocol,
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

    // 7.2.1.1.  Detecting and Repairing Role Conflicts
    if (
      this.iceControlling &&
      message.attributesKeys.includes("ICE-CONTROLLING")
    ) {
      if (this._tieBreaker >= message.attributes["ICE-CONTROLLING"]) {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
        return;
      } else {
        this.switchRole(false);
      }
    } else if (
      !this.iceControlling &&
      message.attributesKeys.includes("ICE-CONTROLLED")
    ) {
      if (this._tieBreaker >= message.attributes["ICE-CONTROLLED"]) {
        this.switchRole(true);
      } else {
        this.respondError(message, addr, protocol, [487, "Role Conflict"]);
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

    if (!this.checkList) {
      this.earlyChecks.push([message, addr, protocol]);
    } else {
      this.checkIncoming(message, addr, protocol);
    }
  }

  async getComponentCandidates(
    component: number,
    addresses: string[],
    timeout = 5
  ) {
    let candidates = [];

    for (let address of addresses) {
      // # create transport
      const protocol = new StunProtocol(this);
      await protocol.connectionMade(isIPv4(address));
      protocol.localAddress = address;
      this.protocols.push(protocol);

      // # add host candidate
      const candidateAddress = protocol.getExtraInfo;

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
    }

    // # query STUN server for server-reflexive candidates (IPv4 only)
    if (this.stunServer) {
      try {
        const fs = (
          await Promise.all<Candidate>(
            this.protocols.map(
              (protocol) =>
                new Promise(async (r, f) => {
                  setTimeout(f, timeout * 1000);
                  if (
                    protocol.localCandidate?.host &&
                    isIPv4(protocol.localCandidate?.host)
                  ) {
                    const candidate = await serverReflexiveCandidate(
                      protocol,
                      this.stunServer!
                    );
                    r(candidate);
                  } else {
                    r(undefined);
                  }
                })
            )
          )
        ).filter((v) => v);
        candidates = [...candidates, ...fs];
      } catch (error) {
        this.log("query STUN server", error);
      }
    }

    return candidates;
  }

  async gatherCandidates() {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;
      const address = getHostAddress(this.useIpv4, this.useIpv6);
      for (let component of this._components) {
        this.localCandidates = [
          ...this.localCandidates,
          ...(await this.getComponentCandidates(component, address)),
        ];
      }
      this._localCandidatesEnd = true;
    }
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
    for (let pair of this.checkList) {
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
  schedulingChecks() {
    // Ordinary Check
    {
      // # find the highest-priority pair that is in the waiting state
      const pair = this.checkList.find(
        (pair) => pair.state === CandidatePairState.WAITING
      );
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

  async close() {
    // """
    // Close the connection.
    // """

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
    for (let protocol of this.protocols) {
      if (protocol.close) await protocol.close();
    }

    this.protocols = [];
    this.localCandidates = [];
  }

  // 生存確認
  private queryConsent = () =>
    new PCancelable(async (r, f, onCancel) => {
      let failures = 0;

      onCancel(() => {
        failures += CONSENT_FAILURES;
        f("cancel");
      });

      // """
      // Periodically check consent (RFC 7675).
      // """

      while (true) {
        // # randomize between 0.8 and 1.2 times CONSENT_INTERVAL
        await sleep(CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000);

        for (let key of this.nominatedKeys) {
          const pair = this.nominated[Number(key)];
          const request = this.buildRequest(pair);
          try {
            await pair.protocol.request(
              request,
              pair.remoteAddr,
              Buffer.from(this.remotePassword, "utf8"),
              0
            );
            failures = 0;
          } catch (error) {
            failures++;
          }
          if (failures >= CONSENT_FAILURES) {
            this.log("Consent to send expired");
            this.queryConsentHandle = undefined;
            r(await this.close());
            return;
          }
        }
      }
    });

  async connect() {
    // """
    // Perform ICE handshake.
    //
    // This coroutine returns if a candidate pair was successfully nominated
    // and raises an exception otherwise.
    // """

    if (!this._localCandidatesEnd)
      throw new Error("Local candidates gathering was not performed");
    if (!this.remoteUsername || !this.remotePassword)
      throw new Error("Remote username or password is missing");

    // # 5.7.1. Forming Candidate Pairs
    for (let remoteCandidate of this.remoteCandidates) {
      for (let protocol of this.protocols) {
        if (
          protocol.localCandidate?.canPairWith(remoteCandidate) &&
          !this.findPair(protocol, remoteCandidate)
        ) {
          const pair = new CandidatePair(protocol, remoteCandidate);
          this.checkList.push(pair);
        }
      }
    }
    this.sortCheckList();

    this.unfreezeInitial();

    // # handle early checks
    for (let earlyCheck of this.earlyChecks) {
      this.checkIncoming(...earlyCheck);
    }
    this.earlyChecks = [];

    // # perform checks
    // 5.8.  Scheduling Checks
    while (true) {
      if (!this.schedulingChecks()) break;
      await sleep(20);
    }

    // # wait for completion
    let res: number;
    if (this.checkList.length > 0) {
      res = (await this.checkListState.get()) as any;
    } else {
      res = ICE_FAILED;
    }

    // # cancel remaining checks
    this.checkList.forEach((check) => check.handle?.cancel());

    if (res !== ICE_COMPLETED) {
      throw new Error("ICE negotiation failed");
    }

    // # start consent freshness tests
    this.queryConsentHandle = future(this.queryConsent());
  }

  async send(data: Buffer) {
    // """
    // Send a datagram on the first component.

    // If the connection is not established, a `ConnectionError` is raised.

    // :param data: The data to be sent.
    // """
    await this.sendTo(data, 1);
  }

  async sendTo(data: Buffer, component: number) {
    // """
    // Send a datagram on the specified component.

    // If the connection is not established, a `ConnectionError` is raised.

    // :param data: The data to be sent.
    // :param component: The component on which to send the data.
    // """
    const activePair = this.nominated[component];
    if (activePair) {
      if (activePair.protocol.sendData)
        await activePair.protocol.sendData(data, activePair.remoteAddr);
    } else {
      throw new Error("Cannot send data, not connected");
    }
  }

  get connectedSocket() {
    const activePair = this.nominated[1];
    return {
      socket: activePair.protocol.socket,
      address: activePair.remoteAddr[0],
      port: activePair.remoteAddr[1],
    };
  }

  async recv() {
    // """
    // Receive the next datagram.

    // The return value is a `bytes` object representing the data received.

    // If the connection is not established, a `ConnectionError` is raised.
    // """
    const [data] = await this.recvFrom();
    return data;
  }

  async recvFrom() {
    // """
    // Receive the next datagram.

    // The return value is a `(bytes, component)` tuple where `bytes` is a
    // bytes object representing the data received and `component` is the
    // component on which the data was received.

    // If the connection is not established, a `ConnectionError` is raised.
    // """
    if (this.nominatedKeys.length === 0) {
      throw new Error("Cannot receive data, not connected");
    }
    const promise = this.dataQueue.get();
    const result = await promise;
    if (!result) {
      throw new Error("Connection lost while receiving data");
    }
    return result;
  }
}
