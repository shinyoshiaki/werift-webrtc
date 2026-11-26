import { MediaStream, MediaStreamTrack } from "../../src/media/track";

/** An event target under test and the event type whose `on<type>` handler it has. */
export interface EventTargetCase {
  name: string;
  create: () => { target: any; type: string };
}

/**
 * The reference: Node.js's native `EventTarget`. An `AbortSignal` is used
 * because it is a native `EventTarget` with a native `onabort` handler
 * attribute; dispatching a synthetic `"abort"` event does not abort it.
 */
export const nativeCase: EventTargetCase = {
  name: "native AbortSignal",
  create: () => ({ target: new AbortController().signal, type: "abort" }),
};

/** Every DOM handler attribute of werift's track and stream. */
export const weriftCases: EventTargetCase[] = [
  ...(["ended", "mute", "unmute"] as const).map((type) => ({
    name: `MediaStreamTrack on${type}`,
    create: () => ({ target: new MediaStreamTrack({ kind: "audio" }), type }),
  })),
  ...(["addtrack", "removetrack"] as const).map((type) => ({
    name: `MediaStream on${type}`,
    create: () => ({ target: new MediaStream(), type }),
  })),
];

/**
 * One operation on a target before the dispatches. The callbacks are shared
 * within one run, so adding / removing the same one twice is observable.
 */
export const operations = [
  "addA",
  "addAOnce",
  "addB",
  "addObj",
  "addObjOnce",
  "addPreventer",
  "addPassivePreventer",
  "addRemoverOfB",
  "removeA",
  "removeObj",
  "setH1",
  "setH2",
  "setNull",
] as const;
export type Operation = (typeof operations)[number];

/** Every sequence of {@link operations} up to `maxLength` long (including the empty one). */
export function enumerateSequences(maxLength: number): Operation[][] {
  const sequences: Operation[][] = [[]];
  let previous: Operation[][] = [[]];
  for (let length = 1; length <= maxLength; length++) {
    previous = previous.flatMap((sequence) =>
      operations.map((operation) => [...sequence, operation]),
    );
    sequences.push(...previous);
  }
  return sequences;
}

/**
 * Whether `sequence` sets a handler again after clearing it with `null`.
 * HTML ("deactivate an event handler") removes the listener on `null`, so the
 * handler set again runs after the listeners added meanwhile (as browsers
 * do); Node.js keeps the old position instead, so such a sequence is checked
 * against the HTML order separately, not against Node.js.
 */
export function resetsHandlerAfterNull(sequence: readonly Operation[]) {
  const cleared = sequence.indexOf("setNull");
  return (
    cleared >= 0 &&
    sequence
      .slice(cleared + 1)
      .some((operation) => operation === "setH1" || operation === "setH2")
  );
}

/** What a run observed: per dispatch, the return value and the calls in order. */
export interface RunResult {
  dispatches: { returned: boolean; prevented: boolean; calls: string[] }[];
}

/**
 * Apply `sequence` to a fresh target of `targetCase`, then dispatch two events
 * of its type (`cancelable` as given) and record the calls: the label, whether
 * `this` was the expected receiver and whether the dispatched event was passed.
 */
export function runSequence(
  targetCase: EventTargetCase,
  sequence: readonly Operation[],
  cancelable: boolean,
): RunResult {
  const { target, type } = targetCase.create();
  const calls: string[] = [];
  let current: Event | undefined;
  const record = (label: string, receiver: boolean, event: Event) =>
    calls.push(
      `${label}${receiver ? "" : ":wrong-this"}${event === current ? "" : ":wrong-event"}`,
    );

  function a(this: unknown, event: Event) {
    record("A", this === target, event);
  }
  function b(this: unknown, event: Event) {
    record("B", this === target, event);
  }
  const obj = {
    handleEvent(this: unknown, event: Event) {
      record("Obj", this === obj, event);
    },
  };
  function preventer(this: unknown, event: Event) {
    record("P", this === target, event);
    event.preventDefault();
  }
  function remover(this: unknown, event: Event) {
    record("R", this === target, event);
    target.removeEventListener(type, b);
  }
  function h1(this: unknown, event: Event) {
    record("H1", this === target, event);
  }
  function h2(this: unknown, event: Event) {
    record("H2", this === target, event);
  }

  const apply: Record<Operation, () => void> = {
    addA: () => target.addEventListener(type, a),
    addAOnce: () => target.addEventListener(type, a, { once: true }),
    addB: () => target.addEventListener(type, b),
    addObj: () => target.addEventListener(type, obj),
    addObjOnce: () => target.addEventListener(type, obj, { once: true }),
    addPreventer: () => target.addEventListener(type, preventer),
    addPassivePreventer: () =>
      target.addEventListener(type, preventer, { passive: true }),
    addRemoverOfB: () => target.addEventListener(type, remover),
    removeA: () => target.removeEventListener(type, a),
    removeObj: () => target.removeEventListener(type, obj),
    setH1: () => {
      target[`on${type}`] = h1;
    },
    setH2: () => {
      target[`on${type}`] = h2;
    },
    setNull: () => {
      target[`on${type}`] = null;
    },
  };
  for (const operation of sequence) {
    apply[operation]();
  }

  const dispatches: RunResult["dispatches"] = [];
  for (let i = 0; i < 2; i++) {
    calls.length = 0;
    current = new Event(type, { cancelable });
    const returned = target.dispatchEvent(current);
    dispatches.push({
      returned,
      prevented: current.defaultPrevented,
      calls: [...calls],
    });
  }
  return { dispatches };
}
