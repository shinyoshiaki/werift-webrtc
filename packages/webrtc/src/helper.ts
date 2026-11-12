import { EventEmitter } from "node:events";

/**
 * Run one notification to listeners (an `Event.execute`, an `on*` handler or
 * an `emit`) so that an exception a listener throws is logged and never
 * interrupts the caller's own processing (state propagation, cleanup).
 */
export function notifySafely(
  log: (...args: unknown[]) => void,
  name: string,
  notify: () => void,
) {
  try {
    notify();
  } catch (error) {
    log(`${name} listener failed`, error);
  }
}

export function enumerate<T>(arr: T[]): [number, T][] {
  return arr.map((v, i) => [i, v]);
}

export function divide(from: string, split: string): [string, string] {
  const arr = from.split(split);
  return [arr[0], arr.slice(1).join(split)];
}

export class PromiseQueue {
  queue: { promise: () => Promise<any>; done: () => void }[] = [];
  running = false;

  push = (promise: () => Promise<any>) =>
    new Promise<void>((r) => {
      this.queue.push({ promise, done: r });
      if (!this.running) this.run();
    });

  private async run() {
    const task = this.queue.shift();
    if (task) {
      this.running = true;
      await task.promise();
      task.done();

      this.run();
    } else {
      this.running = false;
    }
  }
}

export class EventTarget extends EventEmitter {
  override emit(type: string | symbol, ...args: any[]) {
    return super.emit(type, ...this.eventArgs(type, args));
  }

  /**
   * @internal
   * Like {@link emit}, but every listener runs even if an earlier one
   * throws: each exception is passed to `onError` (`once` listeners still
   * run once). Unlike `emit("error")`, nothing is thrown when no listener
   * is registered.
   */
  emitIsolated(
    onError: (error: unknown) => void,
    type: string,
    ...args: any[]
  ) {
    const eventArgs = this.eventArgs(type, args);
    for (const listener of this.rawListeners(type)) {
      try {
        (listener as (...args: any[]) => void).apply(this, eventArgs);
      } catch (error) {
        onError(error);
      }
    }
  }

  /** The DOM-like event arguments: an Event with `type` as the first one. */
  private eventArgs(type: string | symbol, args: any[]): any[] {
    if (typeof type !== "string") {
      return args;
    }

    if (args.length === 0) {
      return [new Event(type)];
    }

    const [event, ...rest] = args;
    if (event && typeof event === "object" && !("type" in event)) {
      try {
        Object.defineProperty(event, "type", {
          configurable: true,
          enumerable: true,
          value: type,
        });
      } catch {
        return [{ type, ...event }, ...rest];
      }
    }

    return [event, ...rest];
  }

  addEventListener = (
    type: string,
    listener: (...args: any[]) => void,
    options?: boolean | { once?: boolean },
  ) => {
    if (typeof options === "object" && options?.once) {
      this.once(type, listener);
      return;
    }
    this.addListener(type, listener);
  };

  removeEventListener = (type: string, listener: (...args: any[]) => void) => {
    this.removeListener(type, listener);
  };

  dispatchEvent = (event: Event) => this.emit(event.type, event);
}
