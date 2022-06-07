import dns from "dns";
import { setTimeout } from "timers/promises";
import util from "util";

import { PromiseQueue } from "../../../common/src";

class DnsLookup {
  queue = new PromiseQueue();

  async lookup(host: string) {
    return this.queue.push(() => this.task(host));
  }

  private async task(host: string) {
    try {
      const res = await Promise.race([
        util.promisify(dns.lookup)(host),
        setTimeout(200),
      ]);
      if (!res) {
        throw undefined;
      }
      return res.address;
    } catch (error) {
      return "127.0.0.1";
    }
  }
}

export const dnsLookup = new DnsLookup();
