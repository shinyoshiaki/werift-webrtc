type EventExecute<T extends any[]> = (...args: T) => void;
type PromiseEventExecute<T extends any[]> = (...args: T) => Promise<void>;
type EventComplete = () => void;
type EventError = (e: any) => void;
interface Stack<T extends any[]> {
  execute: EventExecute<T>;
  complete?: EventComplete;
  error?: EventError;
  id: number;
}
interface IEvent<T extends any[]> {
  stack: Stack<T>[];
  promiseStack: {
    execute: PromiseEventExecute<T>;
    complete?: EventComplete;
    error?: EventError;
    id: number;
  }[];
  eventId: number;
}

export class Event<T extends any[]> {
  private event: IEvent<T> = {
    stack: [],
    promiseStack: [],
    eventId: 0,
  };
  ended = false;
  onended?: () => void;
  onerror = (e: any) => {};
  private readonly onListenerError?: (e: unknown) => void;

  /**
   * @param options.onListenerError When given, a throwing subscriber is
   * reported to it and the remaining subscribers still run. Without it the
   * first exception propagates out of `execute` (default).
   */
  constructor(options: { onListenerError?: (e: unknown) => void } = {}) {
    this.onListenerError = options.onListenerError;
  }

  execute = (...args: T) => {
    if (this.ended) {
      return;
    }

    for (const item of this.event.stack) {
      if (this.onListenerError) {
        try {
          item.execute(...args);
        } catch (error) {
          this.onListenerError(error);
        }
      } else {
        item.execute(...args);
      }
    }

    (async () => {
      for (const item of this.event.promiseStack) {
        await item.execute(...args);
      }
    })().catch((e) => {
      this.onerror(e);
    });
  };

  /**
   * Like {@link execute}, but every synchronous subscriber runs even if an
   * earlier one throws: each exception is passed to `onError` instead of
   * ending the iteration. For events whose later subscribers carry internal
   * work (state propagation, cleanup) that an application subscriber
   * registered before them must not be able to skip.
   */
  /**
   * Like {@link executeIsolated}, but `shouldStop` is checked before each
   * subscriber: once it returns true, the remaining subscribers are not
   * called (a DOM-like `stopImmediatePropagation`). A subscriber that
   * throws is reported to `onError` and the next one still runs. One added
   * during the call is not called; one removed during it is skipped. The
   * promise subscribers (`asPromise` / `watch`) are not run when stopped.
   */
  executeUntil(
    shouldStop: () => boolean,
    onError: (error: unknown) => void,
    ...args: T
  ) {
    if (this.ended) {
      return;
    }

    // A snapshot: a subscriber added meanwhile is not called this time; one
    // removed meanwhile is skipped (as DOM listeners).
    for (const item of [...this.event.stack]) {
      if (shouldStop()) return;
      if (!this.event.stack.includes(item)) continue;
      try {
        item.execute(...args);
      } catch (error) {
        onError(error);
      }
    }
    if (shouldStop()) return;

    (async () => {
      for (const item of this.event.promiseStack) {
        await item.execute(...args);
      }
    })().catch((e) => {
      this.onerror(e);
    });
  }

  executeIsolated(onError: (error: unknown) => void, ...args: T) {
    if (this.ended) {
      return;
    }

    for (const item of this.event.stack) {
      try {
        item.execute(...args);
      } catch (error) {
        onError(error);
      }
    }

    (async () => {
      for (const item of this.event.promiseStack) {
        await item.execute(...args);
      }
    })().catch((e) => {
      this.onerror(e);
    });
  }

  complete = () => {
    if (this.ended) {
      return;
    }

    for (const item of this.event.stack) {
      if (item.complete) {
        item.complete();
      }
    }
    this.allUnsubscribe();
    this.ended = true;
    if (this.onended) {
      this.onended();
      this.onended = undefined;
    }
  };

  error = (e: any) => {
    if (this.ended) {
      return;
    }

    for (const item of this.event.stack) {
      if (item.error) {
        item.error(e);
      }
    }
    this.allUnsubscribe();
  };

  allUnsubscribe = () => {
    // complete() 後の再呼び出しを許容し、close 経路での二重クリーンアップを安全にする
    if (this.ended) {
      return;
    }

    this.event = {
      stack: [],
      promiseStack: [],
      eventId: 0,
    };
  };

  subscribe = (
    execute: EventExecute<T>,
    complete?: EventComplete,
    error?: EventError,
  ) => {
    const id = this.event.eventId;
    this.event.stack.push({ execute, id, complete, error });
    this.event.eventId++;

    const unSubscribe = () => {
      this.event.stack = this.event.stack.filter(
        (item) => item.id !== id && item,
      );
    };

    const disposer = (disposer: EventDisposer) => {
      disposer.push(unSubscribe);
    };

    return { unSubscribe, disposer };
  };

  pipe(e: Event<T>) {
    this.subscribe((...args) => {
      e.execute(...args);
    });
  }

  queuingSubscribe = (
    execute: PromiseEventExecute<T>,
    complete?: EventComplete,
    error?: EventError,
  ) => {
    if (this.ended) throw new Error("event completed");

    const id = this.event.eventId;
    this.event.promiseStack.push({ execute, id, complete, error });
    this.event.eventId++;

    const unSubscribe = () => {
      this.event.stack = this.event.stack.filter(
        (item) => item.id !== id && item,
      );
    };

    const disposer = (disposer: EventDisposer) => {
      disposer.push(unSubscribe);
    };

    return { unSubscribe, disposer };
  };

  once = (
    execute: EventExecute<T>,
    complete?: EventComplete,
    error?: EventError,
  ) => {
    const off = this.subscribe(
      (...args) => {
        off.unSubscribe();
        execute(...args);
      },
      complete,
      error,
    );
  };

  watch = (cb: (...args: T) => boolean, timeLimit?: number) =>
    new Promise<T>((resolve, reject) => {
      const timeout =
        timeLimit &&
        setTimeout(() => {
          reject("Event watch timeout");
        }, timeLimit);

      const { unSubscribe } = this.subscribe((...args) => {
        const done = cb(...args);
        if (done) {
          if (timeout) clearTimeout(timeout);
          unSubscribe();
          resolve(args);
        }
      });
    });

  asPromise = (timeLimit?: number) =>
    new Promise<T>((resolve, reject) => {
      const timeout =
        timeLimit &&
        setTimeout(() => {
          reject("Event asPromise timeout");
        }, timeLimit);

      this.once(
        (...args) => {
          if (timeout) clearTimeout(timeout);
          resolve(args);
        },
        () => {
          if (timeout) clearTimeout(timeout);
          resolve([] as any);
        },
        (err) => {
          if (timeout) clearTimeout(timeout);
          reject(err);
        },
      );
    });

  get returnTrigger() {
    const { execute, error, complete } = this;
    return { execute, error, complete };
  }

  get returnListener() {
    const { subscribe, once, asPromise } = this;
    return { subscribe, once, asPromise };
  }

  get length() {
    return this.event.stack.length;
  }
}

export class EventDisposer {
  private _disposer: (() => void)[] = [];

  push(disposer: () => void) {
    this._disposer.push(disposer);
  }

  dispose() {
    this._disposer.forEach((d) => d());
    this._disposer = [];
  }
}
