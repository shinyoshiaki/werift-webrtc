import worker_thread from "worker_threads";

interface DnsLookupRequest {
  host: string;
}

interface DnsLookupResult extends DnsLookupRequest {
  err?: string;
  address?: string;
  family?: number;
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
