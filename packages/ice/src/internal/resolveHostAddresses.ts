import { isIPv4 } from "node:net";

import type { InterfaceAddresses } from "../imports/common";

export type ResolveHostAddressesLog = (...args: unknown[]) => void;

/**
 * How the UDP host socket of a gathered address is bound.
 *
 * - `explicit`: the family's `interfaceAddresses` address; the socket binds it
 *   and advertises the bound address.
 * - `enumerated`: a locally enumerated address; the socket binds that address
 *   (`bindAddress`) so its packets leave from the advertised address.
 * - `wildcard`: an address not assigned to a local interface (an
 *   `additionalHostAddresses` entry such as a 1:1 NAT public address), or a
 *   family explicitly bound to `0.0.0.0` / `::`; the socket binds the
 *   wildcard address and advertises `address`.
 * @enum
 */
export const HostAddressBind = {
  explicit: "explicit",
  enumerated: "enumerated",
  wildcard: "wildcard",
} as const;
/** @enum */
export type HostAddressBind =
  (typeof HostAddressBind)[keyof typeof HostAddressBind];

/** A host address to gather and how its UDP socket is bound. */
export interface HostAddress {
  /** Address the host candidate is gathered for (never carries a zone). */
  address: string;
  bind: HostAddressBind;
  /** Address the socket binds for `enumerated` (zone of a link-local IPv6). */
  bindAddress?: string;
}

/** A locally enumerated address and the address its socket binds. */
export interface EnumeratedHostAddress {
  address: string;
  bindAddress?: string;
}

const isUnspecified = (address: string) =>
  address === "0.0.0.0" || address === "::";

/**
 * gather 対象の host アドレスと、その UDP ソケットの bind 方針を決める
 * （package-private）。公開 barrel (`src/index.ts`) からは export しない。
 *
 * - `interfaceAddresses.udp4` / `udp6` が指定されたファミリーは、指定アドレス
 *   1 個だけを使う（`explicit`）。列挙結果に含まれなくても採用し、別アドレスへ
 *   フォールバックしない（UDP ソケットはそのアドレスに bind されるため）。
 * - ただし指定アドレスが `0.0.0.0` / `::` のファミリーは、そのファミリーの
 *   列挙アドレスと追加アドレスを wildcard ソケットで収集する（`wildcard`）。
 *   wildcard アドレス自体は advertise しない。
 * - 指定アドレスと異なる同ファミリーの `additionalHostAddresses` は無視する
 *   （指定アドレスと同じものは従来どおり採用し、重複は排除する）。
 * - いずれかのファミリーが指定されているとき、指定のないファミリーの
 *   列挙アドレスは使わない（従来の挙動を維持）。`additionalHostAddresses`
 *   のそのファミリーのアドレスは従来どおり追加する。
 * - どのファミリーも指定がなければ、列挙アドレスに `additionalHostAddresses`
 *   をマージする。列挙アドレスはそのアドレスに bind し（`enumerated`）、
 *   列挙に含まれない追加アドレスは wildcard ソケットで収集する（`wildcard`）。
 * - `useIpv4` / `useIpv6` が false のファミリーの指定アドレスは使わない。
 */
export function resolveHostAddresses({
  enumerated,
  interfaceAddresses,
  additionalHostAddresses = [],
  useIpv4,
  useIpv6,
  log = () => {},
}: {
  enumerated: (string | EnumeratedHostAddress)[];
  interfaceAddresses?: InterfaceAddresses;
  additionalHostAddresses?: string[];
  useIpv4: boolean;
  useIpv6: boolean;
  log?: ResolveHostAddressesLog;
}): HostAddress[] {
  const locals = new Map<string, string>();
  for (const entry of enumerated) {
    const { address, bindAddress = address } =
      typeof entry === "string" ? { address: entry } : entry;
    if (!locals.has(address)) locals.set(address, bindAddress);
  }
  const udp4 = interfaceAddresses?.udp4;
  const udp6 = interfaceAddresses?.udp6;
  const explicitOf = (address: string) => (isIPv4(address) ? udp4 : udp6);

  const resolved = new Map<string, HostAddress>();
  const add = (host: HostAddress) => {
    if (!resolved.has(host.address)) resolved.set(host.address, host);
  };
  // Without an explicit (non-wildcard) address for its family, an address
  // assigned to a local interface is bound to itself, any other one to the
  // wildcard address.
  const localOrWildcard = (address: string): HostAddress => {
    const explicit = explicitOf(address);
    const bindAddress = locals.get(address);
    if (!explicit && bindAddress !== undefined) {
      return { address, bind: HostAddressBind.enumerated, bindAddress };
    }
    return { address, bind: HostAddressBind.wildcard };
  };

  if (!udp4 && !udp6) {
    for (const address of additionalHostAddresses) {
      add(localOrWildcard(address));
    }
    for (const address of locals.keys()) {
      add(localOrWildcard(address));
    }
    return [...resolved.values()];
  }

  for (const [explicit, enabled] of [
    [udp4, useIpv4],
    [udp6, useIpv6],
  ] as const) {
    if (!explicit || !enabled) continue;
    if (isUnspecified(explicit)) {
      // The family is explicitly bound to the wildcard address: gather its
      // enumerated addresses over wildcard sockets.
      for (const address of locals.keys()) {
        if (explicitOf(address) === explicit) {
          add({ address, bind: HostAddressBind.wildcard });
        }
      }
    } else {
      add({ address: explicit, bind: HostAddressBind.explicit });
    }
  }

  for (const address of additionalHostAddresses) {
    const explicit = explicitOf(address);
    if (!explicit || isUnspecified(explicit)) {
      add(localOrWildcard(address));
      continue;
    }
    if (address === explicit) {
      continue; // already gathered as the explicit address
    }
    log(
      "ignore additionalHostAddress; its family is bound to interfaceAddress",
      address,
      explicit,
    );
  }

  return [...resolved.values()];
}
