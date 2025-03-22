import { randomBytes } from "crypto";

import { Event } from "./imports/common";

export function randomString(length: number) {
  return randomBytes(length).toString("hex").substring(0, length);
}

export function randomTransactionId() {
  return randomBytes(12);
}

export function bufferXor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new TypeError(
      "[webrtc-stun] You can not XOR buffers which length are different",
    );
  }

  const length = a.length;
  const buffer = Buffer.allocUnsafe(length);

  for (let i = 0; i < length; i++) {
    buffer[i] = a[i] ^ b[i];
  }

  return buffer;
}

export function difference<T>(x: Set<T>, y: Set<T>) {
  return new Set([...x].filter((e) => !y.has(e)));
}

// infinite size queue
export class PQueue<T> {
  private queue: Promise<T>[] = [];
  private wait = new Event<[Promise<T>]>();

  put(v: Promise<T>) {
    this.queue.push(v);
    if (this.queue.length === 1) {
      this.wait.execute(v);
    }
  }

  get(): Promise<T> {
    const v = this.queue.shift();
    if (!v) {
      return new Promise((r) => {
        this.wait.subscribe((v) => {
          this.queue.shift();
          r(v);
        });
      });
    }
    return v!;
  }
}

export const cancelable = <T>(
  ex: (
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: any) => void,
    onCancel: Event<[any]>,
  ) => Promise<void>,
) => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;

  const p = new Promise<T>((r, f) => {
    resolve = r;
    reject = f;
  });
  p.then(() => {
    onCancel.execute(undefined);
    onCancel.complete();
  }).catch((e) => {
    onCancel.execute(e ?? new Error());
    onCancel.complete();
  });

  const onCancel = new Event<[any]>();

  ex(resolve, reject, onCancel).catch(() => {});

  return { awaitable: p, resolve, reject };
};

export type Cancelable<T> = ReturnType<typeof cancelable<T>>;
