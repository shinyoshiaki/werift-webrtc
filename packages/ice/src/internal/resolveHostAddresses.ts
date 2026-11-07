import { isIPv4 } from "node:net";

import type { InterfaceAddresses } from "../imports/common";

export type ResolveHostAddressesLog = (...args: unknown[]) => void;

/**
 * gather 対象の host アドレスを決める（package-private）。
 * 公開 barrel (`src/index.ts`) からは export しない。
 *
 * - `interfaceAddresses.udp4` / `udp6` が指定されたファミリーは、指定アドレス
 *   1 個だけを使う。列挙結果に含まれなくても採用し、別アドレスへ
 *   フォールバックしない（UDP ソケットはそのアドレスに bind されるため）。
 * - 指定アドレスと異なる同ファミリーの `additionalHostAddresses` は無視する
 *   （指定アドレスと同じものは従来どおり採用し、重複は排除する）。
 * - いずれかのファミリーが指定されているとき、指定のないファミリーの
 *   列挙アドレスは使わない（従来の挙動を維持）。`additionalHostAddresses`
 *   のそのファミリーのアドレスは従来どおり追加する。
 * - どのファミリーも指定がなければ、従来どおり列挙アドレスに
 *   `additionalHostAddresses` をマージする。
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
  enumerated: string[];
  interfaceAddresses?: InterfaceAddresses;
  additionalHostAddresses?: string[];
  useIpv4: boolean;
  useIpv6: boolean;
  log?: ResolveHostAddressesLog;
}): string[] {
  const udp4 = interfaceAddresses?.udp4;
  const udp6 = interfaceAddresses?.udp6;

  if (!udp4 && !udp6) {
    return Array.from(new Set([...additionalHostAddresses, ...enumerated]));
  }

  const explicit: string[] = [];
  if (udp4 && useIpv4) explicit.push(udp4);
  if (udp6 && useIpv6) explicit.push(udp6);

  const additional = additionalHostAddresses.filter((address) => {
    const explicitAddress = isIPv4(address) ? udp4 : udp6;
    if (!explicitAddress) {
      return true;
    }
    if (address === explicitAddress) {
      return true;
    }
    log(
      "ignore additionalHostAddress; its family is bound to interfaceAddress",
      address,
      explicitAddress,
    );
    return false;
  });

  return Array.from(new Set([...explicit, ...additional]));
}
