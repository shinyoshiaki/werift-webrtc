import { randomBytes } from "crypto";
import { Subject } from "rxjs";
import PCancelable from "p-cancelable";

export function randomString(length: number) {
  return randomBytes(length).toString("hex").substring(0, length);
}

export function randomTransactionId() {
  return randomBytes(12);
}

export function bufferXor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new TypeError(
      "[webrtc-stun] You can not XOR buffers which length are different"
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
  private wait = new Subject<Promise<T>>();

  put(v: Promise<T>) {
    this.queue.push(v);
    if (this.queue.length === 1) {
      this.wait.next(v);
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

export const future = (pCancel: PCancelable<any>) => {
  const state = { done: false };

  const cancel = () => pCancel.cancel();

  const done = () => state.done;

  pCancel
    .then(() => {
      state.done = true;
    })
    .catch((error) => {
      if (error !== "cancel") {
        console.log(error);
      }
    });

  return { cancel, promise: pCancel, done };
};

export type Future = ReturnType<typeof future>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
