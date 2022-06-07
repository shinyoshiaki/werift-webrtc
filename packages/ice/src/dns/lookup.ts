import dns from "dns";
import { setTimeout } from "timers/promises";
import util from "util";

import { PromiseQueue } from "../../../common/src";

class DnsLookup {
  private queue = new PromiseQueue();
  private requesting = false;
  private cache: { [local: string]: string } = {};

  async lookup(host: string) {
    return this.queue.push(() => this.task(host));
  }

  private async task(host: string) {
    if (this.cache[host]) {
      return this.cache[host];
    }

    try {
      if (this.requesting) {
        throw undefined;
      }

      this.requesting = true;
      const promise = util.promisify(dns.lookup)(host);
      promise.then(() => {
        this.requesting = false;
      });

      const res = await Promise.race([promise, setTimeout(200)]);
      if (!res) {
        throw undefined;
      }
      this.cache[host] = res.address;
      return res.address;
    } catch (error) {
      return "127.0.0.1";
    }
  }
}

export const dnsLookup = new DnsLookup();
