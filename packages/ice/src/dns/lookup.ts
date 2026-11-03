import * as worker_thread from "node:worker_threads";
import mdns from "multicast-dns";

interface DnsLookupRequest {
  host: string;
}

interface DnsLookupResult extends DnsLookupRequest {
  err?: string;
  address?: string;
  family?: number;
}

/** The part of a `multicast-dns` instance {@link MdnsLookup} uses. */
export type MdnsInstance = Pick<
  mdns.MulticastDNS,
  "on" | "removeListener" | "query" | "destroy" | "setMaxListeners"
>;

/**
 * Resolves remote `.local` candidates. Every pending lookup is owned by the
 * instance: `close()` cancels them (timer, listener and promise) at once.
 */
export class MdnsLookup {
  mdnsInstance: MdnsInstance;
  private closed = false;
  /** Cancels each pending lookup (rejects it and releases its timer and listener). */
  private readonly pending = new Set<() => void>();

  /** @param createMdns creates the mDNS socket; tests inject a fake one. */
  constructor(createMdns: () => MdnsInstance = () => mdns()) {
    this.mdnsInstance = createMdns();
    this.mdnsInstance.setMaxListeners(50);
  }

  /** @internal Number of lookups still waiting for a response. */
  get pendingCount() {
    return this.pending.size;
  }

  lookup(host: string): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("mDNS lookup closed"));
    }
    return new Promise((r, f) => {
      const settle = (settleWith: () => void) => {
        if (!this.pending.delete(cancel)) return;
        this.mdnsInstance.removeListener("response", l);
        clearTimeout(timeout);
        settleWith();
      };
      const cancel = () => settle(() => f(new Error("mDNS lookup cancelled")));

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
