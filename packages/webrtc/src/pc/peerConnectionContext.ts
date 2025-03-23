import { randomUUID } from "node:crypto";
import cloneDeep from "lodash/cloneDeep.js";
import type { PeerConfig } from "./util";
import { EventTarget, enumerate } from "../helper";
import { useOPUS, usePCMU, useVP8 } from "../media";

export class RTCPeerConnectionContext extends EventTarget {
  readonly cname = randomUUID();
  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig);
  negotiationneeded = false;
  needRestart = false;

  constructor() {
    super();
  }

  toJSON() {
    return {
      cname: this.cname,
      config: this.config,
      negotiationneeded: this.negotiationneeded,
    };
  }
}

export const defaultPeerConfig: PeerConfig = {
  codecs: {
    audio: [useOPUS(), usePCMU()],
    video: [useVP8()],
  },
  headerExtensions: {
    audio: [],
    video: [],
  },
  iceTransportPolicy: "all",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  icePortRange: undefined,
  iceInterfaceAddresses: undefined,
  iceAdditionalHostAddresses: undefined,
  iceUseIpv4: true,
  iceUseIpv6: true,
  iceFilterStunResponse: undefined,
  iceFilterCandidatePair: undefined,
  icePasswordPrefix: undefined,
  iceUseLinkLocalAddress: undefined,
  dtls: {},
  bundlePolicy: "max-compat",
  debug: {},
  midSuffix: false,
  forceTurnTCP: false,
};
