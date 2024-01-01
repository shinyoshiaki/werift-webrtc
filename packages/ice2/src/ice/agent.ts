import * as nodeIp from "ip";
import os from "os";
import { StunAgent } from "../stun/agent";
import { isIPv4 } from "net";
import {
  IceCandidate,
  IceCandidateImpl,
  IceCandidatePair,
  IceParameters,
  candidateFoundation,
  candidatePriority,
} from "./candidate";
import { UdpTransport } from "../udp";
import Event from "rx.mini";
import { randomString } from "../util";
import { randomBytes } from "crypto";
import { Binding, Request, StunAttribute, StunMessage } from "../stun/message";
import {
  Attributes,
  IPv4,
  xorIPv4Address,
  xorIPv6Address,
} from "../stun/attributes";
import { isEqual } from "lodash";
import { Address } from "../model";

//    5.  ICE Candidate Gathering and Exchange  . . . . . . . . . . . .  17
//      5.1.  Full Implementation . . . . . . . . . . . . . . . . . . .  17
//      5.2.  Lite Implementation Procedures  . . . . . . . . . . . . .  23
//      5.3.  Exchanging Candidate Information  . . . . . . . . . . . .  24
//      5.4.  ICE Mismatch  . . . . . . . . . . . . . . . . . . . . . .  26
//    6.  ICE Candidate Processing  . . . . . . . . . . . . . . . . . .  26
//      6.1.  Procedures for Full Implementation  . . . . . . . . . . .  26
//      6.2.  Lite Implementation Procedures  . . . . . . . . . . . . .  38
//    7.  Performing Connectivity Checks  . . . . . . . . . . . . . . .  38
//      7.1.  STUN Extensions . . . . . . . . . . . . . . . . . . . . .  38
//      7.2.  STUN Client Procedures  . . . . . . . . . . . . . . . . .  39
//      7.3.  STUN Server Procedures  . . . . . . . . . . . . . . . . .  45
//    8.  Concluding ICE Processing . . . . . . . . . . . . . . . . . .  50
//      8.1.  Procedures for Full Implementations . . . . . . . . . . .  50
//      8.2.  Procedures for Lite Implementations . . . . . . . . . . .  52
//      8.3.  Freeing Candidates  . . . . . . . . . . . . . . . . . . .  53
//    9.  ICE Restarts  . . . . . . . . . . . . . . . . . . . . . . . .  53

interface IceAgentOptions {
  useIpv4: boolean;
  useIpv6: boolean;
  isLite: boolean;
}

export type IceRole = "controlling" | "controlled";
// 6.1.2.1. Checklist State
export type IceCheckListState = "waiting" | "running" | "completed" | "failed";
export type IceState = "completed" | "failed" | "running";

export class IceAgent {
  options: IceAgentOptions;
  onIceCandidate = new Event<[IceCandidateImpl]>();
  localCandidates: IceCandidateImpl[] = [];
  remoteCandidates: IceCandidate[] = [];
  role: IceRole = "controlling";
  remoteIsLite = false;
  localUserName = randomString(4);
  localPassword = randomString(22);
  remoteUserName = "";
  remotePassword = "";
  isLite: boolean;
  checkListState: IceCheckListState = "waiting";
  checkList: IceCandidatePair[] = [];
  validList: IceCandidatePair[] = [];
  /**6.1.4.1. トリガーチェックのキュー */
  triggeredCheckQueue: IceCandidatePair[] = [];
  tieBreaker: bigint = randomBytes(8).readBigInt64BE(0);

  /**6.1.3.ICEステート */
  get state(): IceState {
    if (this.checkListState === "failed") {
      return "failed";
    }
    if (this.checkListState === "completed") {
      return "completed";
    }
    return "running";
  }

  constructor(role:IceRole, options: Partial<IceAgentOptions> = {}) {
    options.useIpv4 ??= true;
    options.isLite ??= false;
    this.options = options as IceAgentOptions;

    this.isLite = options.isLite;
    this.role = role;

    this.onIceCandidate.subscribe((candidate) => {
      this.localCandidates.push(candidate);
    });
  }

  async gatherCandidates() {
    const candidates = await this.gatheringHost();
    if (this.options.isLite) {
      return [candidates[0]];
    }

    const srflxCandidates = await this.gatheringServerReflexive(candidates);
    return [...candidates, ...srflxCandidates];
  }

  private async gatheringHost() {
    const addr = getHostAddresses(this.options.useIpv4, this.options.useIpv6);

    return Promise.all(
      addr.map(async (addr) => {
        const transport = await UdpTransport.init(
          isIPv4(addr) ? "udp4" : "udp6",
          addr
        );
        const stun = new StunAgent(["stun.l.google.com", 19302], transport);
        stun.onRequest.subscribe(({ message, address }) => {
          this.bindingRequestReceived({ message, remoteAddr: address, stun });
        });
        await stun.setup();
        const candidate = new IceCandidateImpl({
          address: transport.address,
          transport: "udp",
          foundation: candidateFoundation("host", "udp", addr),
          componentId: 1,
          priority: candidatePriority("host"),
          type: "host",
          protocol: stun,
        });
        this.onIceCandidate.execute(candidate);
        return candidate;
      })
    );
  }

  // 7.3.STUNサーバーの手順
  private bindingRequestReceived({
    stun,
    message,
    remoteAddr,
  }: {
    stun: StunAgent;
    message: StunMessage;
    remoteAddr: Address;
  }) {
    if (message.header.messageType.stunMethod !== Binding) {
      this.respondingError({ errorCode: [400, "Bad Request"] });
      return;
    }

    // 7.3.1.フル実装のための追加手続き
    // 7.3.1.1.roleの衝突の検出と修復
    const controlling = Attributes.iceControlling.deserialize(
      message.attributes
    );
    if (this.role === "controlling" && controlling) {
      if (this.tieBreaker >= controlling.value) {
        this.respondingError({ errorCode: [487, "Role Conflict"] });
        return;
      } else {
        this.changeRole("controlled");
      }
    }

    const controlled = Attributes.iceControlled.deserialize(message.attributes);
    if (this.role === "controlled" && controlled) {
      if (this.tieBreaker >= controlled.value) {
        this.changeRole("controlling");
      } else {
        this.respondingError({ errorCode: [487, "Role Conflict"] });
        return;
      }
    }

    // 7.3.1.3.ピアリフレ候補の学習
    let remoteCandidate = this.remoteCandidates.find((c) =>
      isEqual(c.address, remoteAddr)
    );
    if (!remoteCandidate) {
      const priority = Attributes.priority.deserialize(message.attributes)!;
      const candidate: IceCandidate = {
        address: remoteAddr,
        foundation: randomString(10),
        componentId: 1,
        priority: priority.value,
        type: "prflx",
        transport: "udp",
      };
      this.remoteCandidates.push(candidate);
      remoteCandidate = candidate;
    }

    // 7.3.1.4.トリガーチェック
    const pair = this.triggerCheck(stun, remoteCandidate);

    // 7.3.1.5.指名フラグを更新する
    const useCandidate = Attributes.useCandidate.deserialize(
      message.attributes
    );
    if (this.role === "controlled" && useCandidate) {
      if (pair.state === "succeeded") {
        pair.nominated = true;
        this.validList.push(pair);
      }
    }
  }

  // 7.3.1.4.トリガーチェック
  private triggerCheck(
    stun: StunAgent,
    remoteCandidate: IceCandidate
  ): IceCandidatePair {
    const localCandidate = this.localCandidates.find((c) =>
      isEqual(c.address, stun.transport.address)
    )!;
    let pair = this.checkList.find(
      (p) =>
        p.localCandidate.address === localCandidate.address &&
        p.remoteCandidate.address === remoteCandidate.address
    );

    // o ペアがすでにチェックリストに入っている場合。
    if (pair) {
      if (pair.state === "succeeded") {
        return pair;
      }
      if (pair.state === "inprogress") {
        stun.cancelAllTransaction();
        this.triggeredCheckQueue.push(pair);
        pair.state = "waiting";
      }
      if (
        pair.state === "waiting" ||
        pair.state === "frozen" ||
        pair.state === "failed"
      ) {
        if (!this.triggeredCheckQueue.find((p) => p.id === pair!.id)) {
          this.triggeredCheckQueue.push(pair);
          pair.state = "waiting";
        }
      }

      return pair;
    } else {
      const pair = new IceCandidatePair({
        role: this.role,
        local: localCandidate,
        remote: remoteCandidate,
      });
      this.checkList.push(pair);
      this.sortPairList(this.checkList);
      pair.state = "waiting";
      this.triggeredCheckQueue.push(pair);

      return pair;
    }
  }

  /**todo */
  private respondingError({ errorCode }: { errorCode: [number, string] }) {}

  private changeRole(role: IceRole) {
    this.role = role;
    this.sortPairList(this.checkList);
  }

  private async gatheringServerReflexive(candidates: IceCandidateImpl[]) {
    return await Promise.all(
      candidates.map(async (candidate) => {
        const stun = candidate.protocol;
        const xAddress = await stun.binding();

        // todo 5.1.1.4.Keeping Candidates Alive

        const srflxCandidate = new IceCandidateImpl({
          address: xAddress,
          transport: "udp",
          foundation: candidateFoundation("srflx", "udp", xAddress[0]),
          componentId: 1,
          priority: candidatePriority("srflx"),
          type: "srflx",
          protocol: stun,
        });
        this.onIceCandidate.execute(srflxCandidate);
        return srflxCandidate;
      })
    );
  }

  setRemoteParameters({ isLite, usernameFragment, password }: IceParameters) {
    this.remoteIsLite = isLite;
    this.remotePassword = password;
    this.remoteUserName = usernameFragment;
  }

  async addRemoteCandidate(candidate: IceCandidate) {
    this.remoteCandidates.push(candidate);
    this.determiningRole(this.localCandidates.length === 0);

    // 6.2.Liteの導入手順

    if (this.isLite) {
      if (this.remoteIsLite) {
        const pair = new IceCandidatePair({
          role: this.role,
          local: this.localCandidates[0],
          remote: candidate,
        });
        // todo
      }
      return;
    }

    // 6.1.2.2. Forming Candidate Pairs
    for (const localCandidate of this.localCandidates) {
      if (localCandidate.componentId !== candidate.componentId) continue;
      if (isIPv4(localCandidate.address[0]) !== isIPv4(candidate.address[0]))
        continue;

      const pair = new IceCandidatePair({
        role: this.role,
        local: localCandidate,
        remote: candidate,
      });
      // 6.1.2.4. Pruning the Pairs
      if (this.checkList.find((p) => p.shouldPrune(pair))) continue;

      this.checkList.push(pair);
    }
    // 6.1.2.3.ペアの優先順位の計算とペアの順序付け
    this.sortPairList(this.checkList);

    // todo 6.1.2.5.下位優先度ペアの削除

    // The agent sets all of the checklists in the checklist set to the Running state.
    this.checkListState = "running";

    const pair = this.checkList[0];
    pair.state = "waiting";

    for (;;) {
      await this.performingConnectivityCheck();
      // timer Ta
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // 6.1.4.2. Performing Connectivity Checks
  private async performingConnectivityCheck() {
    //1
    const pair = this.triggeredCheckQueue.shift();
    if (pair) {
      pair.state = "inprogress";
      await this.connectivityCheck(pair);
      return;
    }

    //2
    const frozen = this.checkList.find((p) => p.state === "frozen");
    if (!this.checkList.find((p) => p.state === "waiting") && frozen) {
      frozen.state = "waiting";
    }

    //3
    const waiting = this.checkList.find((p) => p.state === "waiting");
    if (waiting) {
      waiting.state = "inprogress";
      await this.connectivityCheck(waiting);
      return;
    }

    //4
    // single checklist
  }

  private sortPairList(list: IceCandidatePair[]) {
    list.sort((a, b) => a.candidatePairPriority - b.candidatePairPriority);
  }

  private determiningRole(triggered: boolean) {
    // 6.1.1. Determining Role
    //  両エージェントともFullである：
    //  ICE処理を開始した開始エージェントは制御する役割を、
    //  もう一方のエージェントは制御される役割を取らなければならない(MUST)。
    //  両エージェントは、チェックリストを形成し、ICEステートマシンを実行し、接続性チェックを生成する。
    //  制御するエージェントは、セクション8.1のロジックを実行し、
    //  (指名に関連する 接続性チェックが成功すれば)選択されたペアとなるペアを指名し、
    //  両エージェント はセクション8.1.2の説明に従ってICEを終了する。

    // 1つのエージェントがフルで、1つのエージェントがライトである：
    // フルエージェントがcontrollingの役割を担い、ライトエージェントがcontrolledの役割を担わなければならない(MUST)。
    // フルエージェントはチェックリストを作成し、ICEステートマシンを実行し、接続性チェックを生成する。
    // そのエージェントは、セクション8.1のロジックを実行し、
    // (指名に関連するコネクティビティチェックが成功した場合)選択されたペアになるペアを指名し、
    // セクション8.1.2のロジックを使用してICEを終了させる。
    // ライト実装では、接続性チェックをリッスンし、それを受信して応答し、
    // 8.2節で説明するようにICEを終了させるだけである。
    // lite実装では、各データストリームのICE処理の状態はRunning、ICE全体の状態はRunningとみなされる。

    // ともにliteである：
    // ICE処理を開始したイニシエーションエージェントは、
    // 制御の役割を果たさなければならず（MUST）、他は制御される役割を果たさなければならない（MUST）。
    // この場合、接続性チェックが送信されることはない。
    // むしろ、候補が交換されると、各エージェントは接続性チェッ クなしでセクション8で説明されている処理を実行する。
    // 両エージェントが、自分がコントロールされている、あるいはコントロールしていると思い込む可能性がある。
    // 後者の場合、候補の交換を可能にするシグナリングプロトコルのグレア検出機能によって、競合が解決される。
    // 各データストリームのICE処理の状態はRunningとみなされ、ICE全体の状態はRunningとなる。
    if (this.remoteIsLite === false && this.isLite === false) {
      if (triggered) {
        this.role = "controlled";
      } else {
        this.role = "controlling";
      }
    }
    if (
      (this.remoteIsLite === false && this.isLite) ||
      (this.remoteIsLite && this.isLite === false)
    ) {
      if (this.isLite) this.role = "controlled";
      else this.role = "controlling";
    }
    if (this.remoteIsLite && this.isLite) {
      if (triggered) {
        this.role = "controlled";
      } else {
        this.role = "controlling";
      }
    }
  }

  async connectivityCheck(pair: IceCandidatePair) {
    const txUsername = `${this.remoteUserName}:${this.localUserName}`;
    const attributes: StunAttribute[] = [
      Attributes.username.serialize(txUsername),
      //7.1.1.優先順位
      Attributes.priority.serialize(candidatePriority("prflx")),
    ];
    if (this.role === "controlling") {
      //7.1.2.USE-CANDIDATE
      attributes.push(Attributes.useCandidate.serialize());
      attributes.push(Attributes.iceControlling.serialize(this.tieBreaker));
    } else {
      attributes.push(Attributes.iceControlled.serialize(this.tieBreaker));
    }

    const message = pair.client.buildMessage({
      stunClass: Request,
      stunMethod: Binding,
      attributes,
    });
    const res = await pair.client.request(message).catch((e) => e as Error);
    // 7.2.5.2.3.タイムアウト
    if (res instanceof Error) {
      pair.state = "failed";
      return;
    }

    const { message: response, address } = res;

    const error = Attributes.errorCode.deserialize(response.attributes);
    // 7.2.5.1.roleの相反
    if (error?.code === 487) {
      if (this.role === "controlling") {
        this.role = "controlled";
      } else {
        this.role = "controlling";
      }
      this.tieBreaker = randomBytes(8).readBigInt64BE(0);
      this.triggeredCheckQueue.push(pair);
      pair.state = "waiting";
      return;
    }

    // 7.2.5.2.失敗の場合
    // 7.2.5.2.1.非対称型トランスポートアドレス
    if (!isEqual(address, pair.remoteCandidate.address)) {
      pair.state = "failed";

      return;
    }

    // 7.2.5.3.サクセス
    // 7.2.5.3.1.ピアリフレックス候補の発見
    {
      const xorMappedAddress = Attributes.xorMappedAddress.deserialize(
        response.attributes
      )!;
      const address =
        xorMappedAddress.family === IPv4
          ? xorIPv4Address(xorMappedAddress.xAddress)
          : xorIPv6Address(xorMappedAddress.xAddress);
      // todo
    }

    // 7.2.5.3.2.valid pairを構成する
    this.validList.push(pair);
    this.sortPairList(this.validList);

    // 7.2.5.3.3.ペア候補の状態更新
    pair.state = "succeeded";
    const frozen = this.checkList.filter(
      (p) =>
        p.localCandidate.foundation === pair.localCandidate.foundation &&
        p.state === "frozen"
    );
    for (const p of frozen) {
      p.state = "waiting";
    }

    // 7.2.5.3.4.指名フラグを更新する
    if (this.role === "controlling") {
      pair.nominated = true;
    } else {
      // const useCandidate = Attributes.useCandidate.deserialize(
      //   response.attributes
      // );
      // if (useCandidate) {
      pair.nominated = true;
      // }
    }

    // 7.2.5.4.チェックリストの状態更新
    const succeededOrFailed = this.checkList.filter(
      (p) => p.state === "succeeded" || p.state === "failed"
    );
    if (succeededOrFailed.length === this.checkList.length) {
      if (this.validList.length === 0) {
        this.checkListState = "failed";
      } else {
        this.checkListState = "completed";
      }
    }
  }
}

export function getHostAddresses(useIpv4: boolean, useIpv6: boolean) {
  const address: string[] = [];
  if (useIpv4) address.push(...nodeIpAddress(4));
  if (useIpv6) address.push(...nodeIpAddress(6));
  return address;
}

function nodeIpAddress(family: number): string[] {
  // https://chromium.googlesource.com/external/webrtc/+/master/rtc_base/network.cc#236
  const costlyNetworks = ["ipsec", "tun", "utun", "tap"];
  const banNetworks = ["vmnet", "veth"];

  const interfaces = os.networkInterfaces();

  const all = Object.keys(interfaces)
    .map((nic) => {
      for (const word of [...costlyNetworks, ...banNetworks]) {
        if (nic.startsWith(word)) {
          return {
            nic,
            addresses: [],
          };
        }
      }
      const addresses = interfaces[nic]!.filter(
        (details) =>
          normalizeFamilyNodeV18(details.family) === family &&
          !nodeIp.isLoopback(details.address) &&
          !isAutoConfigurationAddress(details)
      );
      return {
        nic,
        addresses: addresses.map((address) => address.address),
      };
    })
    .filter((address) => !!address);

  // os.networkInterfaces doesn't actually return addresses in a good order.
  // have seen instances where en0 (ethernet) is after en1 (wlan), etc.
  // eth0 > eth1
  all.sort((a, b) => a.nic.localeCompare(b.nic));
  return Object.values(all)
    .map((entry) => entry.addresses)
    .flat();
}

function isAutoConfigurationAddress(info: os.NetworkInterfaceInfo) {
  return (
    normalizeFamilyNodeV18(info.family) === 4 &&
    info.address?.startsWith("169.254.")
  );
}

export function normalizeFamilyNodeV18(family: string | number): 4 | 6 {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;

  return family as 4 | 6;
}
