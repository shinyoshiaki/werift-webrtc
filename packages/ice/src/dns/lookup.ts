import * as dgram from "node:dgram";
import * as worker_thread from "node:worker_threads";
import mdns from "multicast-dns";

import { debug, normalizeFamilyNodeV18 } from "../imports/common";
import {
  type NetworkInterfaceEnumeration,
  readNetworkInterfaces,
} from "../internal/hostInterfaces";

const log = debug("werift-ice : packages/ice/src/dns/lookup.ts : log");

interface DnsLookupRequest {
  host: string;
}

interface DnsLookupResult extends DnsLookupRequest {
  err?: string;
  address?: string;
  family?: number;
}

/**
 * The IPv4 address multicast-dns would join on each interface (its
 * `allInterfaces()`: the first IPv4 address of every interface).
 */
const multicastInterfaces = (
  interfaces: NetworkInterfaceEnumeration["interfaces"],
) =>
  Object.values(interfaces).flatMap((infos) => {
    const ipv4 = (infos ?? []).find(
      (info) => normalizeFamilyNodeV18(info.family) === 4,
    );
    return ipv4 ? [ipv4.address] : [];
  });

/** multicast-dns' `defaultInterface()`, from an enumeration already made. */
const defaultMulticastInterface = (
  interfaces: NetworkInterfaceEnumeration["interfaces"],
) => {
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (normalizeFamilyNodeV18(info.family) === 4 && !info.internal) {
        return process.platform === "darwin" && name === "en0"
          ? info.address
          : "0.0.0.0";
      }
    }
  }
  return "127.0.0.1";
};

/**
 * The default mDNS socket of {@link MdnsLookup} (package-private).
 *
 * multicast-dns enumerates the interfaces itself (os.networkInterfaces())
 * when its socket starts listening and again every 5 seconds, in callbacks
 * of the event loop: where the enumeration is not allowed (e.g. AF_NETLINK
 * denied by systemd's RestrictAddressFamilies=) that throw would end the
 * process. So its `update()` (the membership refresh) is replaced by one that
 * enumerates without throwing: interfaces that appear later are still joined
 * (a failed enumeration is only a `warning`, retried at the next tick). The
 * socket keeps binding to the wildcard address as before. The first
 * enumeration is made here: when it fails this throws, and MdnsLookup then
 * opens no socket that listens.
 * @param options more multicast-dns options (tests choose the port).
 */
export function createMulticastDns(options: mdns.Options = {}) {
  const first = readNetworkInterfaces();
  if (first.error !== undefined) throw first.error;

  const group = options.ip ?? "224.0.0.251";
  const socket =
    options.socket ??
    dgram.createSocket({
      type: "udp4",
      reuseAddr: options.reuseAddr !== false,
    });
  const instance = mdns({
    bind: "0.0.0.0",
    ...options,
    socket,
  } as mdns.Options);

  const joined = new Set<string>();
  let initial: NetworkInterfaceEnumeration | undefined = first;
  (instance as unknown as { update: () => void }).update = () => {
    const enumeration = initial ?? readNetworkInterfaces();
    initial = undefined;
    if (enumeration.error !== undefined) {
      instance.emit("warning", enumeration.error);
      return;
    }
    let updated = false;
    for (const address of multicastInterfaces(enumeration.interfaces)) {
      if (joined.has(address)) continue;
      try {
        socket.addMembership(group, address);
        joined.add(address);
        updated = true;
      } catch (error) {
        instance.emit("warning", error);
      }
    }
    if (!updated) return;
    try {
      socket.setMulticastInterface(
        (options.interface as string | undefined) ??
          defaultMulticastInterface(enumeration.interfaces),
      );
    } catch (error) {
      instance.emit("warning", error);
    }
    instance.emit("networkInterface");
  };
  return instance;
}

/**
 * Resolves remote `.local` candidates. Every pending lookup is owned by the
 * instance: `close()` cancels them (timer, listener and promise) at once.
 */
export class MdnsLookup {
  cache = new Map<string, Promise<string>>();
  mdnsInstance: mdns.MulticastDNS;
  private closed = false;
  /** Cancels each pending lookup (rejects it and releases its timer and listener). */
  private readonly pending = new Set<() => void>();

  /**
   * Why the mDNS socket cannot resolve (it could not be created, or it gave
   * an `error` such as EACCES / EADDRINUSE): every lookup rejects with it.
   */
  private failure?: unknown;

  /**
   * @param createMdns creates the mDNS socket; tests inject a fake one. When
   * it throws (the default one does when the network interfaces cannot be
   * enumerated), a socket that never binds stands in for it and every lookup
   * rejects at once.
   */
  constructor(
    createMdns: () => mdns.MulticastDNS = () => createMulticastDns(),
  ) {
    try {
      this.mdnsInstance = createMdns();
    } catch (error) {
      log("mDNS socket unavailable", error);
      this.failure = error;
      // Neither binds nor joins a group: no listening, no interval timer.
      this.mdnsInstance = mdns({ bind: false, multicast: false });
    }
    this.mdnsInstance.setMaxListeners(50);
    // multicast-dns re-emits a socket's EACCES / EADDRINUSE as `error`, which
    // would end the process without a listener: the socket is unusable then,
    // so the pending lookups reject and so do later ones.
    this.mdnsInstance.on("error", (error: unknown) => {
      log("mDNS socket error", error);
      this.failure ??= error;
      for (const cancel of [...this.pending]) cancel();
    });
    this.mdnsInstance.on("warning", (warning: unknown) => {
      log("mDNS socket warning", warning);
    });
  }

  /** @internal Number of lookups still waiting for a response. */
  get pendingCount() {
    return this.pending.size;
  }

  lookup(host: string): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("mDNS lookup closed"));
    }
    if (this.failure !== undefined) {
      return Promise.reject(this.unavailableError());
    }
    return new Promise((r, f) => {
      const settle = (settleWith: () => void) => {
        if (!this.pending.delete(cancel)) return;
        this.mdnsInstance.removeListener("response", l);
        clearTimeout(timeout);
        settleWith();
      };
      const cancel = () =>
        settle(() =>
          f(
            this.failure !== undefined
              ? this.unavailableError()
              : new Error("mDNS lookup cancelled"),
          ),
        );

      const timeout = setTimeout(() => {
        settle(() => f(new Error("No mDNS response")));
      }, 10000);

      const l = (response: mdns.ResponsePacket) => {
        const a = response.answers?.[0];
        if (a?.type !== "A") {
          return;
        }
        if (a.name !== host) {
          return;
        }

        settle(() => r(a.data));
      };
      this.pending.add(cancel);
      this.mdnsInstance.on("response", l);

      this.mdnsInstance.query(host, "A");
    });
  }

  private unavailableError() {
    return new Error("mDNS lookup unavailable", { cause: this.failure });
  }

  /** Cancel every pending lookup and release the socket. Idempotent. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
    this.mdnsInstance.destroy();
  }
}

export class DnsLookup {
  thread: worker_thread.Worker;
  cache = new Map<string, Promise<string>>();

  constructor() {
    const lookupWorkerFunction = () => {
      // hoist-imports-allow: eval'd worker must resolve modules inside the worker isolate
      const worker_thread = global.require("worker_threads");
      const { lookup } = global.require("dns");

      const dnsLookup = (host: string) =>
        lookup(host, (err: Error, address: string, family: number) => {
          const res: DnsLookupResult = {
            err: err?.message,
            address,
            family,
            host,
          };
          worker_thread.parentPort?.postMessage(res);
          process.exit();
        });

      worker_thread.parentPort?.on("message", (message: DnsLookupRequest) => {
        const { host } = message;
        dnsLookup(host);
      });
    };

    const lookupEval = `(${lookupWorkerFunction})()`;

    this.thread = new worker_thread.Worker(lookupEval, {
      eval: true,
    });

    this.thread.setMaxListeners(100);
  }

  async lookup(host: string): Promise<string> {
    let cached = this.cache.get(host);
    if (cached) {
      return cached;
    }
    cached = new Promise((r, f) => {
      const exitListener = (exitCode: number) =>
        f(new Error(`dns.lookup thread exited unexpectedly: ${exitCode}`));

      const threadMessageListener = (result: DnsLookupResult) => {
        if (result.host !== host) {
          return;
        }

        this.thread.removeListener("message", threadMessageListener);
        this.thread.removeListener("exit", exitListener);

        if (!result.address)
          return f(new Error(result.err || "dns.lookup thread unknown error"));
        r(result.address);
      };

      this.thread.on("message", threadMessageListener);
      this.thread.on("exit", exitListener);

      this.thread.postMessage({
        host,
      } as DnsLookupRequest);
    });

    this.cache.set(host, cached);
    return cached;
  }

  close() {
    return this.thread.terminate();
  }
}
