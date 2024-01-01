import * as nodeIp from "ip";
import os from "os";
import { StunAgent } from "../stun/agent";
import { isIPv4 } from "net";
import {
  IceCandidate,
  candidateFoundation,
  candidatePriority,
} from "./candidate";
import { UdpTransport } from "../udp";
import Event from "rx.mini";

interface IceAgentOptions {
  useIpv4: boolean;
  useIpv6: boolean;
  isLite: boolean;
}

export class IceAgent {
  options: IceAgentOptions;
  onIceCandidate = new Event<[IceCandidate]>();

  constructor(options: Partial<IceAgentOptions> = {}) {
    options.useIpv4 ??= true;
    options.isLite ??= false;
    this.options = options as IceAgentOptions;
  }

  async gatheringCandidates() {
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
        await stun.setup();
        const candidate = new IceCandidate({
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

  private async gatheringServerReflexive(candidates: IceCandidate[]) {
    return await Promise.all(
      candidates.map(async (candidate) => {
        const stun = candidate.protocol;
        const xAddress = await stun.binding();

        // todo 5.1.1.4.Keeping Candidates Alive

        const srflxCandidate = new IceCandidate({
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
