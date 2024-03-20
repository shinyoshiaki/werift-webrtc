import os from "os";
import * as nodeIp from "ip";
import { InterfaceAddresses } from "../../common/src/network";
import { Connection, serverReflexiveCandidate } from "./ice";
import { StunProtocol } from "./stun/protocol";
import { Address } from "./types/model";

export async function getGlobalIp(
  stunServer?: Address,
  interfaceAddresses?: InterfaceAddresses,
) {
  const connection = new Connection(true, {
    stunServer: stunServer ?? ["stun.l.google.com", 19302],
  });
  await connection.gatherCandidates();

  const protocol = new StunProtocol(connection);
  protocol.localCandidate = connection.localCandidates[0];
  await protocol.connectionMade(true, undefined, interfaceAddresses);
  const candidate = await serverReflexiveCandidate(protocol, [
    "stun.l.google.com",
    19302,
  ]);

  await connection.close();
  await protocol.close();

  if (!candidate?.host) {
    throw new Error("host not exist");
  }

  return candidate?.host;
}

export function normalizeFamilyNodeV18(family: string | number): 4 | 6 {
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;

  return family as 4 | 6;
}

function isAutoconfigurationAddress(info: os.NetworkInterfaceInfo) {
  return (
    normalizeFamilyNodeV18(info.family) === 4 &&
    info.address?.startsWith("169.254.")
  );
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
          !isAutoconfigurationAddress(details),
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
  return Object.values(all).flatMap((entry) => entry.addresses);
}

export function getHostAddresses(useIpv4: boolean, useIpv6: boolean) {
  const address: string[] = [];
  if (useIpv4) address.push(...nodeIpAddress(4));
  if (useIpv6) address.push(...nodeIpAddress(6));
  return address;
}
