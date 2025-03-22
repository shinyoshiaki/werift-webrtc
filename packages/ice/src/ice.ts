import { randomBytes } from "crypto";
import { isIPv4 } from "net";

import * as Int64 from "int64-buffer";

import isEqual from "lodash/isEqual.js";
import timers from "timers/promises";
import { type Address, Event, debug } from "./imports/common";

import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import { MdnsLookup } from "./dns/lookup";
import type { TransactionError } from "./exceptions";
import { type Cancelable, PQueue, cancelable, randomString } from "./helper";
import {
  CONSENT_FAILURES,
  CONSENT_INTERVAL,
  CandidatePair,
  CandidatePairState,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  defaultOptions,
  serverReflexiveCandidate,
  sortCandidatePairs,
  validateAddress,
  validateRemoteCandidate,
} from "./iceBase";
import { classes, methods } from "./stun/const";
import { Message } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol } from "./types/model";
import { getHostAddresses } from "./utils";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

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
  private readonly tieBreaker: bigint = BigInt(
    new Int64.Uint64BE(randomBytes(64)).toString(),
  );
  state: IceState = "new";
  lookup?: MdnsLookup;

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  nominated?: CandidatePair;
  private nominating = false;
  private checkListDone = false;
  private checkListState = new PQueue<number>();
  private earlyChecks: [Message, Address, Protocol][] = [];
  private earlyChecksDone = false;
  private localCandidatesStart = false;
  private protocols: Protocol[] = [];
  private queryConsentHandle?: Cancelable<void>;
  private promiseGatherCandidates?: Event<[]>;

  readonly onData = new Event<[Buffer]>();
  readonly stateChanged = new Event<[IceState]>();
  readonly onIceCandidate: Event<[Candidate]> = new Event();

  constructor(
    private _iceControlling: boolean,
    options?: Partial<IceOptions>,
  ) {
    this.options = {
      ...defaultOptions,
      ...options,
    };
    const { stunServer, turnServer } = this.options;
    this.stunServer = validateAddress(stunServer) ?? [
      "stun.l.google.com",
      19302,
    ];
    this.turnServer = validateAddress(turnServer);
    this.restart();
    log("new Connection", this.options);
  }

  get iceControlling() {
    return this._iceControlling;
  }

  set iceControlling(value: boolean) {
    if (this.generation > 0 || this.nominated) {
      return;
    }
    this._iceControlling = value;
    for (const pair of this.checkList) {
      pair.iceControlling = value;
    }
  }

  async restart() {
    this.generation++;

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
    this.checkListState = new PQueue<number>();
    this.earlyChecks = [];
    this.earlyChecksDone = false;
    this.localCandidatesStart = false;

    // protocolsはincomingのearlyCheckに使うかもしれないので残す
    for (const protocol of this.protocols) {
      if (protocol.localCandidate) {
        protocol.localCandidate.generation = this.generation;
        protocol.localCandidate.ufrag = this.localUsername;
      }
    }

    this.queryConsentHandle?.resolve?.();
    this.queryConsentHandle = undefined;
    this.promiseGatherCandidates = undefined;
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.nominating = false;
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
  async gatherCandidates() {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;
      this.promiseGatherCandidates = new Event();

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

      const candidates = await this.getCandidates(address, 5);
      this.localCandidates = [...this.localCandidates, ...candidates];

      this.localCandidatesEnd = true;
      this.promiseGatherCandidates.execute();
    }
    this.setState("completed");
  }

  private ensureProtocol(protocol: Protocol) {
    protocol.onRequestReceived.subscribe((msg, addr, data) => {
      if (msg.messageMethod !== methods.BINDING) {
        this.respondError(msg, addr, protocol, [400, "Bad Request"]);
        return;
      }

      const txUsername = msg.getAttributeValue("USERNAME");
      // 相手にとってのremoteは自分にとってのlocal
      const { remoteUsername: localUsername } = decodeTxUsername(txUsername);
      const localPassword =
        this.userHistory[localUsername] ?? this.localPassword;

      const { iceControlling } = this;

      // 7.2.1.1.  Detecting and Repairing Role Conflicts
      if (iceControlling && msg.attributesKeys.includes("ICE-CONTROLLING")) {
        if (this.tieBreaker >= msg.getAttributeValue("ICE-CONTROLLING")) {
          this.respondError(msg, addr, protocol, [487, "Role Conflict"]);
          return;
        } else {
          this.switchRole(false);
        }
      } else if (
        !iceControlling &&
        msg.attributesKeys.includes("ICE-CONTROLLED")
      ) {
        if (this.tieBreaker < msg.getAttributeValue("ICE-CONTROLLED")) {
          this.respondError(msg, addr, protocol, [487, "Role Conflict"]);
        } else {
          this.switchRole(true);
          return;
        }
      }

      if (
        this.options.filterStunResponse &&
        !this.options.filterStunResponse(msg, addr, protocol)
      ) {
        return;
      }

      // # send binding response
      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        msg.transactionId,
      );

      response
        .setAttribute("XOR-MAPPED-ADDRESS", addr)
        .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
        .addFingerprint();
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });

      if (this.checkList.length === 0 && !this.earlyChecksDone) {
        this.earlyChecks.push([msg, addr, protocol]);
      } else {
        this.checkIncoming(msg, addr, protocol);
      }
    });
    protocol.onDataReceived.subscribe((data) => {
      try {
        this.onData.execute(data);
      } catch (error) {
        log("dataReceived", error);
      }
    });
  }

  private async getCandidates(addresses: string[], timeout = 5) {
    let candidates: Candidate[] = [];

    addresses = addresses.filter((address) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      if (this.protocols.find((protocol) => protocol.localIp === address)) {
        return false;
      }
      return true;
    });

    await Promise.allSettled(
      addresses.map(async (address) => {
        // # create transport
        const protocol = new StunProtocol();
        this.ensureProtocol(protocol);
        try {
          await protocol.connectionMade(
            isIPv4(address),
            this.options.portRange,
            this.options.interfaceAddresses,
          );
        } catch (error) {
          log("error protocol STUN", error);
          return;
        }

        protocol.localIp = address;
        this.protocols.push(protocol);

        // # add host candidate
        const candidateAddress: Address = [address, protocol.getExtraInfo()[1]];

        protocol.localCandidate = new Candidate(
          candidateFoundation("host", "udp", candidateAddress[0]),
          1,
          "udp",
          candidatePriority("host"),
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
        candidates.push(protocol.localCandidate);
        this.onIceCandidate.execute(protocol.localCandidate);
      }),
    );

    log(
      "protocols",
      this.protocols.map((p) => p.localIp),
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
            ).catch((error) => {
              log("error", error);
            });
            if (candidate) {
              this.onIceCandidate.execute(candidate);
            }

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
        const protocol = await createStunOverTurnClient(
          {
            address: turnServer,
            username: turnUsername,
            password: turnPassword,
          },
          {
            portRange: this.options.portRange,
            interfaceAddresses: this.options.interfaceAddresses,
            transport: this.options.turnTransport === "tcp" ? "tcp" : "udp",
          },
        ).catch(async (e) => {
          if (this.options.turnTransport !== "tcp") {
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
        this.onIceCandidate.execute(protocol.localCandidate);

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
    log("start connect ice");
    if (!this.localCandidatesEnd) {
      if (!this.localCandidatesStart) {
        throw new Error("Local candidates gathering was not performed");
      }
      if (this.promiseGatherCandidates) {
        // wait for GatherCandidates finish
        await this.promiseGatherCandidates.asPromise();
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

    this.unfreezeInitial();

    log("earlyChecks", this.localPassword, this.earlyChecks.length);
    // # handle early checks
    for (const earlyCheck of this.earlyChecks) {
      this.checkIncoming(...earlyCheck);
    }
    this.earlyChecks = [];
    this.earlyChecksDone = true;

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
      log("checkListState", res);
    }

    // # cancel remaining checks
    for (const check of this.checkList) {
      check.handle?.resolve?.();
    }

    if (res !== ICE_COMPLETED) {
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

  // 4.1.1.4 ? 生存確認 life check
  private queryConsent = () => {
    if (this.queryConsentHandle) {
      this.queryConsentHandle.resolve();
    }

    this.queryConsentHandle = cancelable(async (_, __, onCancel) => {
      let failures = 0;
      let canceled = false;

      const cancelEvent = new AbortController();
      onCancel.once(() => {
        canceled = true;
        failures += CONSENT_FAILURES;
        cancelEvent.abort();
        this.queryConsentHandle = undefined;
      });

      const { localUsername, remoteUsername, iceControlling } = this;

      // """
      // Periodically check consent (RFC 7675).
      // """

      try {
        while (this.state !== "closed" && !canceled) {
          // # randomize between 0.8 and 1.2 times CONSENT_INTERVAL
          await timers.setTimeout(
            CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000,
            undefined,
            { signal: cancelEvent.signal },
          );

          const nominated = this.nominated;
          if (!nominated || canceled) {
            break;
          }

          const request = this.buildRequest({
            nominate: false,
            localUsername,
            remoteUsername,
            iceControlling,
          });
          try {
            await nominated.protocol.request(
              request,
              nominated.remoteAddr,
              Buffer.from(this.remotePassword, "utf8"),
              0,
            );
            failures = 0;
            if (this.state === "disconnected") {
              this.setState("connected");
            }
          } catch (error) {
            if (nominated.id === this.nominated?.id) {
              log("no stun response");
              failures++;
              this.setState("disconnected");
              break;
            }
          }
          if (failures >= CONSENT_FAILURES) {
            log("Consent to send expired");
            this.queryConsentHandle = undefined;
            this.setState("closed");
            break;
          }
        }
      } catch (error) {}
    });
  };

  async close() {
    // """
    // Close the connection.
    // """

    this.setState("closed");

    // # stop consent freshness tests
    this.queryConsentHandle?.resolve?.();

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
    const activePair = this.nominated;
    if (activePair) {
      await activePair.protocol.sendData(data, activePair.remoteAddr);
    } else {
      // log("Cannot send data, ice not connected");
      return;
    }
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

  private switchRole(iceControlling: boolean) {
    log("switch role", iceControlling);
    this.iceControlling = iceControlling;
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

      const nominate = this.iceControlling && !this.remoteIsLite;
      const request = this.buildRequest({
        nominate,
        localUsername,
        remoteUsername,
        iceControlling: this.iceControlling,
      });

      try {
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(remotePassword, "utf8"),
          4,
        );
        log("response received", request.toJSON(), response.toJSON(), addr, {
          localUsername,
          remoteUsername,
          remotePassword,
          generation,
        });
        result.response = response;
        result.addr = addr;
      } catch (error: any) {
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

      // # check remote address matches
      if (!isEqual(result.addr, pair.remoteAddr)) {
        pair.updateState(CandidatePairState.FAILED);
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
        const request = this.buildRequest({
          nominate: true,
          localUsername,
          remoteUsername,
          iceControlling: this.iceControlling,
        });
        try {
          await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8"),
          );
        } catch (error) {
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          return;
        }
        pair.nominated = true;
      }

      pair.updateState(CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

  private addPair(pair: CandidatePair) {
    this.checkList.push(pair);
    this.sortCheckList();
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
        "udp",
        message.getAttributeValue("PRIORITY"),
        host,
        port,
        "prflx",
        undefined,
        undefined,
        undefined,
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
    pair.localCandidate.ufrag = localUsername;

    log("Triggered Checks", message.toJSON(), pair.toJSON(), {
      localUsername: this.localUsername,
      remoteUsername: this.remoteUsername,
      localPassword: this.localPassword,
      remotePassword: this.remotePassword,
      generation: this.generation,
    });

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
  }: {
    nominate: boolean;
    remoteUsername: string;
    localUsername: string;
    iceControlling: boolean;
  }) {
    const txUsername = encodeTxUsername({ remoteUsername, localUsername });
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", txUsername)
      .setAttribute("PRIORITY", candidatePriority("prflx"));
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
