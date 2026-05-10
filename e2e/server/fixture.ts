import { networkInterfaces } from "node:os";

import {
  type DtlsKeys,
  HashAlgorithm,
  type PeerConfig,
  SignatureAlgorithm,
  createSelfSignedCertificate,
} from ".";
import {
  type BundlePolicy,
  NamedCurveAlgorithm,
} from "../../packages/webrtc/src";

export class DtlsKeysContext {
  private static rsa: DtlsKeys;
  private static ecdsa: DtlsKeys;

  static async get() {
    if (this.rsa) {
      return Math.random() > 0.5 ? this.rsa : this.ecdsa;
    }

    this.rsa = await createSelfSignedCertificate({
      signature: SignatureAlgorithm.rsa_1,
      hash: HashAlgorithm.sha256_4,
    });

    this.ecdsa = await createSelfSignedCertificate(
      {
        signature: SignatureAlgorithm.ecdsa_3,
        hash: HashAlgorithm.sha256_4,
      },
      NamedCurveAlgorithm.secp256r1_23,
    );
  }
}

function isPrivateIpv4(address: string) {
  return (
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
}

function getIceLiteInterfaceAddress() {
  const interfaces = Object.entries(networkInterfaces());
  const preferred = interfaces
    .filter(([name]) => !/^(docker|br-|veth|tailscale)/.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .find(
      (address) =>
        address.family === "IPv4" &&
        !address.internal &&
        isPrivateIpv4(address.address),
    );

  if (preferred) {
    return preferred.address;
  }

  const fallback = interfaces
    .flatMap(([, addresses]) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal);

  return fallback?.address;
}

export const peerConfig: Promise<Partial<PeerConfig>> = (async () => ({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  dtls: { keys: await DtlsKeysContext.get() },
  bundlePolicy: "max-bundle" as BundlePolicy,
}))();

export const iceLitePeerConfig: Promise<Partial<PeerConfig>> = (async () => {
  const iceLiteInterfaceAddress = getIceLiteInterfaceAddress();
  return {
    ...(await peerConfig),
    iceLite: true,
    iceServers: [],
    iceUseIpv6: false,
    iceInterfaceAddresses: iceLiteInterfaceAddress
      ? { udp4: iceLiteInterfaceAddress }
      : undefined,
    iceFilterStunResponse: iceLiteInterfaceAddress
      ? (_, __, protocol) => protocol.localCandidate?.host === iceLiteInterfaceAddress
      : undefined,
    iceFilterCandidatePair: iceLiteInterfaceAddress
      ? (pair) => pair.localCandidate.host === iceLiteInterfaceAddress
      : undefined,
  };
})();
