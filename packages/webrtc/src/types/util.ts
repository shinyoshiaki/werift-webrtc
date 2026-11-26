export type CallbackWithValue<T> =
  | ((e: T) => void)
  | ((e: T) => Promise<void>)
  | null
  | undefined;

export type Callback = (() => void) | (() => Promise<void>) | null | undefined;

/**
 * A W3C event handler property: it receives the dispatched event, and a
 * handler that takes no argument stays assignable.
 * @see tests/datachannel/bufferedAmount.test.ts "every event handler receives the same Event object as the listeners"
 */
export type EventHandler<T> = CallbackWithValue<T> | Callback;
