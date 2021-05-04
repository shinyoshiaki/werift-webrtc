import EventEmitter from "events";

export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export function divide(from: string, split: string): [string, string] {
  const arr = from.split(split);
  return [arr[0], arr.slice(1).join(split)];
}

export class PromiseQueue {
  queue: { promise: () => Promise<any>; call: () => void }[] = [];
  running = false;

  push = (promise: () => Promise<any>) =>
    new Promise<void>((r) => {
      this.queue.push({ promise, call: r });
      if (!this.running) this.run();
    });

  async run() {
    const task = this.queue.shift();
    if (task) {
      this.running = true;
      await task.promise();
      task.call();

      this.run();
    } else {
      this.running = false;
    }
  }
}

export class EventTarget extends EventEmitter {
  addEventListener = (type: string, listener: (...args: any[]) => void) => {
    this.addListener(type, listener);
  };
}
