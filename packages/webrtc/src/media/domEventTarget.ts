import { EventTarget } from "../helper";
import { debug } from "../imports/common";

const log = debug("werift:packages/webrtc/src/media/domEventTarget.ts");

/** A DOM `EventListenerObject`: its `handleEvent` is called with `this` set to the object. */
export interface WeriftEventListenerObject {
  handleEvent(event: any): any;
}

/** A DOM `EventListenerOrEventListenerObject`. */
export type WeriftEventListener =
  | ((event: any) => any)
  | WeriftEventListenerObject;

/** The DOM `AddEventListenerOptions` werift honors. */
export interface WeriftAddEventListenerOptions {
  capture?: boolean;
  once?: boolean;
  passive?: boolean;
  signal?: AbortSignal;
}

interface DomListener {
  type: string;
  callback: WeriftEventListener;
  capture: boolean;
  once: boolean;
  passive: boolean;
  removed: boolean;
  wrapper: (event: Event) => void;
}

function captureOf(options?: boolean | { capture?: boolean }) {
  return typeof options === "boolean" ? options : !!options?.capture;
}

/**
 * The DOM `EventTarget` behavior shared by {@link MediaStreamTrack} and
 * {@link MediaStream}, so that a werift track / stream passed to a DOM-typed
 * library behaves like the native one:
 *
 * - `addEventListener` accepts a function or an object with `handleEvent`,
 *   ignores a duplicate (same type, callback and `capture`), and honors
 *   `once`, `passive` and `signal`. A listener removed during a dispatch is not
 *   called.
 * - An `on<type>` handler attribute is a listener at the position where it was
 *   first set to a function (setting another function keeps the position,
 *   setting `null` removes it), so `dispatchEvent` calls it, and a handler
 *   returning `false` cancels a cancelable event.
 * - `dispatchEvent` returns `false` only when a cancelable event was canceled.
 * - An exception a listener or handler throws is logged (`DEBUG=werift*`) and
 *   does not stop the other listeners or reach the caller of `dispatchEvent`
 *   (or of `MediaStreamTrack.stop`), as the DOM reports it instead of
 *   rethrowing.
 *
 * Not modeled: event paths, so `capture` only distinguishes registrations and
 * `event.target` / `currentTarget` stay unset. The Node.js `EventEmitter` API
 * (`on`, `emit`, ...) the class inherits keeps its own semantics.
 */
export class DomEventTarget extends EventTarget {
  private readonly domListeners: DomListener[] = [];
  private readonly handlerAttributes = new Map<
    string,
    { handler: (event: any) => any; listener: DomListener }
  >();

  override addEventListener = (
    type: string,
    callback: WeriftEventListener | null | undefined,
    options?: boolean | WeriftAddEventListenerOptions,
  ) => {
    if (callback == undefined) {
      return;
    }
    const flags = typeof options === "object" ? options : {};
    if (flags.signal?.aborted) {
      return;
    }
    const capture = captureOf(options);
    if (this.findListener(type, callback, capture)) {
      return;
    }
    const listener = this.register(type, callback, {
      capture,
      once: !!flags.once,
      passive: !!flags.passive,
    });
    flags.signal?.addEventListener("abort", () => this.unregister(listener), {
      once: true,
    });
  };

  override removeEventListener = (
    type: string,
    callback: WeriftEventListener | null | undefined,
    options?: boolean | { capture?: boolean },
  ) => {
    if (callback == undefined) {
      return;
    }
    const listener = this.findListener(type, callback, captureOf(options));
    if (listener) {
      this.unregister(listener);
    }
  };

  /** DOM `dispatchEvent()`: `false` only when a cancelable event was canceled. */
  override dispatchEvent = (event: Event) => {
    this.emitIsolated(
      (error) => log(`${event.type} listener failed`, error),
      event.type,
      event,
    );
    return !event.defaultPrevented;
  };

  /** The value of the `on<type>` handler attribute. */
  protected getEventHandler<H>(type: string): H | null {
    return (this.handlerAttributes.get(type)?.handler ?? null) as H | null;
  }

  /** Set the `on<type>` handler attribute (a non-function value clears it, as the DOM does). */
  protected setEventHandler(type: string, handler: unknown) {
    const current = this.handlerAttributes.get(type);
    if (typeof handler !== "function") {
      if (current) {
        this.handlerAttributes.delete(type);
        this.unregister(current.listener);
      }
      return;
    }
    if (current) {
      // DOM と同じく、別の関数に変えても listener の位置は変わらない。
      current.handler = handler as (event: any) => any;
      return;
    }
    const entry = {
      handler: handler as (event: any) => any,
      listener: undefined as unknown as DomListener,
    };
    const callback = (event: Event) => {
      const result = entry.handler.call(this, event);
      if (result === false) {
        event.preventDefault();
      }
    };
    entry.listener = this.register(type, callback, {
      capture: false,
      once: false,
      passive: false,
    });
    this.handlerAttributes.set(type, entry);
  }

  private findListener(
    type: string,
    callback: WeriftEventListener,
    capture: boolean,
  ) {
    return this.domListeners.find(
      (listener) =>
        listener.type === type &&
        listener.callback === callback &&
        listener.capture === capture,
    );
  }

  private register(
    type: string,
    callback: WeriftEventListener,
    flags: { capture: boolean; once: boolean; passive: boolean },
  ) {
    const listener: DomListener = {
      type,
      callback,
      ...flags,
      removed: false,
      wrapper: (event) => this.invoke(listener, event),
    };
    this.domListeners.push(listener);
    this.on(type, listener.wrapper);
    return listener;
  }

  private unregister(listener: DomListener) {
    if (listener.removed) {
      return;
    }
    listener.removed = true;
    const index = this.domListeners.indexOf(listener);
    if (index >= 0) {
      this.domListeners.splice(index, 1);
    }
    this.removeListener(listener.type, listener.wrapper);
  }

  private invoke(listener: DomListener, event: Event) {
    // dispatch 中に削除された listener は呼ばない（DOM の removed フラグ）。
    if (listener.removed) {
      return;
    }
    if (listener.once) {
      this.unregister(listener);
    }
    const restore = listener.passive ? suppressPreventDefault(event) : noop;
    try {
      const { callback } = listener;
      if (typeof callback === "function") {
        callback.call(this, event);
      } else {
        callback.handleEvent(event);
      }
    } catch (error) {
      // DOM と同じく例外は報告だけして、残りの listener と呼び出し元を止めない。
      log(`${listener.type} listener failed`, error);
    } finally {
      restore();
    }
  }
}

function noop() {}

/** A passive listener cannot cancel the event: hide `preventDefault` while it runs. */
function suppressPreventDefault(event: Event) {
  if (typeof event?.preventDefault !== "function") {
    return noop;
  }
  const own = Object.getOwnPropertyDescriptor(event, "preventDefault");
  try {
    Object.defineProperty(event, "preventDefault", {
      configurable: true,
      value: noop,
    });
  } catch {
    return noop;
  }
  return () => {
    if (own) {
      Object.defineProperty(event, "preventDefault", own);
    } else {
      delete (event as { preventDefault?: unknown }).preventDefault;
    }
  };
}
