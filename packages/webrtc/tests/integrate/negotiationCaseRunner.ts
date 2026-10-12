import { describe, expect, test, vi } from "vitest";

import * as werift from "../../src";
import { RTCPeerConnection } from "../../src";
import * as utils from "./negotiationTransactionUtils";

/**
 * Declarative runner of the deterministic negotiation cases. A case is text:
 *
 *   case: <test name; `$key` is replaced by a parameter of `each`>
 *   ref: <spec IDs of NEGOTIATION_SPEC_COVERAGE.md>[; origin: <regression origin>]
 *   given: <initial condition: an expression whose object becomes the scope>
 *   each: <optional parameter rows: one test per row>
 *   exempt: <optional reason why the peers do not reach expectSessionContinues>
 *   <steps, one per line>
 *
 * The runner owns what every case shares: the Arrange of `given`, the
 * negotiation operations, the invariants of every peer after each of them,
 * the state / event / traffic checks, `expectSessionContinues` and closing
 * every peer. The step language is described in `NEGOTIATION_TRANSACTION.md`
 * ("Declarative cases").
 */
export type CaseParams = Record<string, string | number | boolean | null>;
/** A case: its text, or its text with helpers only it uses (case lines). */
export type CaseText = string | { text: string; fns?: Record<string, unknown> };
type NegotiationCase = {
  name: string;
  ref: string;
  given: string;
  each?: CaseParams[];
  steps: string;
  fns?: Record<string, unknown>;
  exempt?: string;
  /** `invariants: explicit`: only at `invariants` steps, not after each operation. */
  explicitInvariants?: boolean;
  timeout?: number;
};
export type CaseOptions = {
  timeout?: number;
  /** Helpers several cases of a domain use. */
  fns?: Record<string, unknown>;
};

type Scope = Record<string, unknown>;
const GLOBALS: Scope = {
  Array,
  Boolean,
  Buffer,
  Date,
  Error,
  Map,
  Set,
  JSON,
  Math,
  Number,
  Object,
  Promise,
  RegExp,
  String,
  undefined,
  NaN,
  vi,
};

// --- expressions -----------------------------------------------------------
//
// A small JavaScript subset: literals (numbers, strings, regular
// expressions, arrays, objects), identifiers of the scope, member access
// (strict: an unknown property is an error; `?.` is lenient), calls, `new`,
// arrow functions, `!`, unary `-`, `+`, `-`, `===`, `!==`, `&&`, `||`, `? :`
// and spread. Evaluation is synchronous; the statement awaits its value.

type Token = {
  kind: "num" | "str" | "tpl" | "re" | "id" | "op";
  text: string;
  value?: unknown;
};
type Node = (scope: Scope) => unknown;
const OPS = [
  "...",
  "===",
  "!==",
  "=>",
  "?.",
  "&&",
  "??",
  "||",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
  "?",
  "!",
  "+",
  "-",
];

function tokenize(source: string) {
  const tokens: Token[] = [];
  let i = 0;
  const regexAllowed = () => {
    const last = tokens.at(-1);
    return !last || (last.kind === "op" && !")]}".includes(last.text));
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = source
        .slice(i)
        .match(/^(0x[0-9a-f]+|\d+(\.\d+)?(e\d+)?|\d+)/i)!;
      tokens.push({
        kind: "num",
        text: m[0],
        value: Number(m[0].replace(/_/g, "")),
      });
      i += m[0].length;
    } else if (c === "`") {
      // template literal: `parts` alternate text and `${expression}` sources
      const parts: string[] = [""];
      let j = i + 1;
      while (source[j] !== "`") {
        if (j >= source.length)
          throw new Error(`unterminated template: ${source}`);
        if (source.startsWith("${", j)) {
          let depth = 1;
          let k = j + 2;
          while (depth > 0) {
            if (source[k] === "{") depth++;
            if (source[k] === "}") depth--;
            k++;
          }
          parts.push(source.slice(j + 2, k - 1), "");
          j = k;
        } else {
          if (source[j] === "\\") {
            const next = source[++j];
            parts[parts.length - 1] +=
              ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[next] ??
              next;
            j++;
          } else parts[parts.length - 1] += source[j++];
        }
      }
      tokens.push({ kind: "tpl", text: source.slice(i, j + 1), value: parts });
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (source[j] !== c) {
        if (j >= source.length)
          throw new Error(`unterminated string: ${source}`);
        if (source[j] === "\\") {
          const next = source[++j];
          text += { n: "\n", r: "\r", t: "\t" }[next] ?? next;
        } else text += source[j];
        j++;
      }
      tokens.push({ kind: "str", text: source.slice(i, j + 1), value: text });
      i = j + 1;
    } else if (c === "/" && regexAllowed()) {
      const m = source
        .slice(i)
        .match(/^\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\[])+)\/([a-z]*)/)!;
      if (!m) throw new Error(`bad regular expression: ${source.slice(i)}`);
      tokens.push({ kind: "re", text: m[0], value: new RegExp(m[1], m[2]) });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = source.slice(i).match(/^[A-Za-z_$][\w$]*/)!;
      tokens.push({ kind: "id", text: m[0] });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => source.startsWith(o, i));
      if (!op) throw new Error(`unexpected "${c}" in: ${source}`);
      tokens.push({ kind: "op", text: op });
      i += op.length;
    }
  }
  return tokens;
}

function lookup(scope: Scope, name: string) {
  if (name in scope) return scope[name];
  throw new Error(`unknown name "${name}"`);
}

function member(
  object: unknown,
  key: PropertyKey,
  lenient: boolean,
  text: string,
) {
  if (object == null) {
    if (lenient) return undefined;
    throw new Error(`cannot read "${String(key)}" of ${object} in: ${text}`);
  }
  if (!(key in Object(object))) {
    if (lenient) return undefined;
    throw new Error(`unknown property "${String(key)}" in: ${text}`);
  }
  return (object as Record<PropertyKey, unknown>)[key];
}

/**
 * Compile an expression to a function of the scope. `await x` (outside an
 * arrow function) is evaluated before the rest of the expression, in source
 * order, so the compiled function returns a promise when it has one.
 */
export function compile(source: string): Node {
  const tokens = tokenize(source);
  let pos = 0;
  const awaits: Node[] = [];
  let arrowDepth = 0;
  const peek = (text?: string) =>
    tokens[pos] && (text === undefined || tokens[pos].text === text)
      ? tokens[pos]
      : undefined;
  const take = (text?: string) => {
    const token = peek(text);
    if (!token)
      throw new Error(`expected ${text ?? "a token"} at ${pos} in: ${source}`);
    pos++;
    return token;
  };
  const isArrow = () => {
    if (peek()?.kind === "id" && tokens[pos + 1]?.text === "=>") return true;
    if (!peek("(")) return false;
    let depth = 0;
    for (let j = pos; j < tokens.length; j++) {
      if (tokens[j].text === "(") depth++;
      if (tokens[j].text === ")" && --depth === 0)
        return tokens[j + 1]?.text === "=>";
    }
    return false;
  };
  const list = (close: string, item: () => Node): Node[] => {
    const items: Node[] = [];
    while (!peek(close)) {
      if (peek("...")) {
        take("...");
        const inner = item();
        items.push(Object.assign((s: Scope) => inner(s), { spread: true }));
      } else items.push(item());
      if (!peek(close)) take(",");
    }
    take(close);
    return items;
  };
  const values = (items: Node[], scope: Scope) =>
    items.flatMap((item) =>
      (item as Node & { spread?: boolean }).spread
        ? [...(item(scope) as unknown[])]
        : [item(scope)],
    );

  const expression = (): Node => {
    if (isArrow()) {
      const params: string[] = [];
      if (peek("(")) {
        take("(");
        while (!peek(")")) {
          params.push(take().text);
          if (!peek(")")) take(",");
        }
        take(")");
      } else params.push(take().text);
      take("=>");
      arrowDepth++;
      const body = expression();
      arrowDepth--;
      return (scope) =>
        (...args: unknown[]) =>
          body(
            Object.assign(
              Object.create(scope),
              Object.fromEntries(params.map((p, i) => [p, args[i]])),
            ),
          );
    }
    const condition = binary(0);
    if (!peek("?")) return condition;
    take("?");
    const yes = expression();
    take(":");
    const no = expression();
    return (scope) => (condition(scope) ? yes(scope) : no(scope));
  };
  const LEVELS = [["||", "??"], ["&&"], ["===", "!=="], ["+", "-"]];
  const binary = (level: number): Node => {
    if (level === LEVELS.length) return unary();
    let left = binary(level + 1);
    while (peek()?.kind === "op" && LEVELS[level].includes(peek()!.text)) {
      const op = take().text;
      const l = left;
      const r = binary(level + 1);
      left = (scope) => {
        if (op === "||") return l(scope) || r(scope);
        if (op === "??") return l(scope) ?? r(scope);
        if (op === "&&") return l(scope) && r(scope);
        const [x, y] = [l(scope), r(scope)] as [never, never];
        return { "===": x === y, "!==": x !== y, "+": x + y, "-": x - y }[op];
      };
    }
    return left;
  };
  const unary = (): Node => {
    if (peek("await")) {
      take();
      if (arrowDepth > 0)
        throw new Error(`await inside an arrow function: ${source}`);
      const operand = unary();
      const slot = `__await${awaits.push(operand) - 1}`;
      return (scope) => scope[slot];
    }
    if (peek("!")) {
      take();
      const inner = unary();
      return (scope) => !inner(scope);
    }
    if (peek("-")) {
      take();
      const inner = unary();
      return (scope) => -(inner(scope) as number);
    }
    return postfix(primary());
  };
  type Part = { key: Node; lenient: boolean } | { args: Node[] };
  const postfix = (start: Node, allowCall = true): Node => {
    const parts: Part[] = [];
    for (;;) {
      if (peek(".") || peek("?.")) {
        const lenient = take().text === "?.";
        if (lenient && peek("[")) {
          // obj?.[key]
          take("[");
          parts.push({ key: expression(), lenient });
          take("]");
          continue;
        }
        const key = take().text;
        parts.push({ key: () => key, lenient });
      } else if (peek("[")) {
        take("[");
        parts.push({ key: expression(), lenient: false });
        take("]");
      } else if (peek("(") && allowCall) {
        take("(");
        parts.push({ args: list(")", expression) });
      } else break;
    }
    if (parts.length === 0) return start;
    return (scope) => {
      let value = start(scope);
      // the object of the last member access is `this` of a call
      let self: unknown;
      for (const part of parts) {
        if ("args" in part) {
          if (typeof value !== "function") {
            throw new Error(`not a function in: ${source}`);
          }
          value = value.apply(self, values(part.args, scope));
          self = undefined;
        } else {
          // `?.` on a nullish object ends the whole chain (optional chaining)
          if (part.lenient && value == null) return undefined;
          self = value;
          value = member(
            value,
            part.key(scope) as PropertyKey,
            part.lenient,
            source,
          );
        }
      }
      return value;
    };
  };
  const primary = (): Node => {
    const token = take();
    if (token.kind === "num" || token.kind === "str") return () => token.value;
    if (token.kind === "tpl") {
      const parts = (token.value as string[]).map((part, i) =>
        i % 2 ? compile(part) : () => part,
      );
      return (scope) => parts.map((part) => String(part(scope))).join("");
    }
    if (token.kind === "re") {
      const re = token.value as RegExp;
      return () => new RegExp(re.source, re.flags);
    }
    if (token.kind === "id") {
      if (token.text === "true") return () => true;
      if (token.text === "false") return () => false;
      if (token.text === "null") return () => null;
      if (token.text === "new") {
        const ctor = postfix(primary(), false);
        take("(");
        const args = list(")", expression);
        return (scope) => {
          const C = ctor(scope) as new (...a: unknown[]) => unknown;
          return new C(...values(args, scope));
        };
      }
      return (scope) => lookup(scope, token.text);
    }
    if (token.text === "(") {
      const inner = expression();
      take(")");
      return inner;
    }
    if (token.text === "[") {
      const items = list("]", expression);
      return (scope) => values(items, scope);
    }
    if (token.text === "{") {
      const props: [string, Node][] = [];
      while (!peek("}")) {
        const key = take();
        const name = key.kind === "str" ? (key.value as string) : key.text;
        if (peek(":")) {
          take(":");
          props.push([name, expression()]);
        } else props.push([name, (scope) => lookup(scope, name)]);
        if (!peek("}")) take(",");
      }
      take("}");
      return (scope) =>
        Object.fromEntries(props.map(([k, v]) => [k, v(scope)]));
    }
    throw new Error(`unexpected "${token.text}" in: ${source}`);
  };

  const node = expression();
  if (pos !== tokens.length) {
    throw new Error(`unexpected "${tokens[pos].text}" in: ${source}`);
  }
  if (awaits.length === 0) return node;
  return async (scope) => {
    const inner = Object.create(scope) as Scope;
    for (const [i, operand] of awaits.entries()) {
      inner[`__await${i}`] = await operand(inner);
    }
    return node(inner);
  };
}

// --- steps -------------------------------------------------------------------

/** Comparators of `expect <actual> <comparator> <expected>`. */
const COMPARATORS: Record<
  string,
  (actual: unknown, expected: unknown, message: string) => void
> = {
  "==": (a, e, m) => expect(a, m).toEqual(e),
  "!=": (a, e, m) => expect(a, m).not.toEqual(e),
  is: (a, e, m) => expect(a, m).toBe(e),
  isnt: (a, e, m) => expect(a, m).not.toBe(e),
  contains: (a, e, m) => expect(a, m).toContain(e),
  /** every element of the expected array, by identity */
  containsAll: (a, e, m) => {
    for (const item of e as unknown[]) expect(a, m).toContain(item);
  },
  lacks: (a, e, m) => expect(a, m).not.toContain(e),
  like: (a, e, m) => expect(a, m).toMatchObject(e as object),
  matches: (a, e, m) => expect(a, m).toMatch(e as RegExp),
  unlike: (a, e, m) => expect(a, m).not.toMatch(e as RegExp),
  "<": (a, e, m) => expect(a, m).toBeLessThan(e as number),
  "<=": (a, e, m) => expect(a, m).toBeLessThanOrEqual(e as number),
  ">": (a, e, m) => expect(a, m).toBeGreaterThan(e as number),
  ">=": (a, e, m) => expect(a, m).toBeGreaterThanOrEqual(e as number),
};

/** Split `text` at the first top-level ` word ` of `words` (outside brackets and strings). */
function splitTop(text: string, words: string[]) {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (`"'\``.includes(c)) quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === " ") {
      const word = words.find((w) => text.startsWith(` ${w} `, i));
      if (word)
        return [text.slice(0, i), word, text.slice(i + word.length + 2)];
    }
  }
  return undefined;
}

/** Trailing `key=value` flags and bare words of `flags`; the rest is the argument. */
function trailingFlags(text: string, bare: string[] = []) {
  const flags: Record<string, string> = {};
  let rest = text.trim();
  for (;;) {
    const m =
      rest.match(/(?:^|\s)(as|type|rejects|timeout)=("[^"]*"|\S+)$/) ??
      rest.match(new RegExp(`(?:^|\\s)(${bare.join("|") || "(?!)"})$`));
    if (!m) break;
    flags[m[1]] = m[2]?.replace(/^"(.*)"$/, "$1") ?? "true";
    rest = rest.slice(0, rest.length - m[0].length).trim();
  }
  return { rest, flags };
}

/**
 * `rejects=Name` (alternatives joined by "|") expects that error name;
 * `rejects="text"` (quoted) a message that contains the text.
 */
function expectRejection(
  error: Error | undefined,
  rejects: string,
  message: string,
) {
  expect(error, `${message}: expected a rejection`).toBeInstanceOf(Error);
  if (/^[\w|]+$/.test(rejects)) {
    expect(error!.name, message).toMatch(new RegExp(`^(${rejects})$`));
  } else expect(error!.message, message).toContain(rejects);
}

const DESCRIPTION_OPS = new Set([
  "createOffer",
  "createAnswer",
  "setLocal",
  "setRemote",
  "addCandidate",
  "offer",
  "answer",
  "pranswer",
  "rollback",
  "negotiate",
  "finish",
  "close",
]);

type Description = { type: string; sdp: string };
type Run = {
  scope: Scope;
  caseName: string;
  created: Map<RTCPeerConnection, Description>;
  cleanup: (() => unknown)[];
  exempt?: string;
  explicitInvariants: boolean;
  step: number;
};

const peersOf = (scope: Scope) =>
  Object.values(scope).filter(
    (v): v is RTCPeerConnection => v instanceof RTCPeerConnection,
  );
const otherPeer = (run: Run, pc: RTCPeerConnection) => {
  const others = peersOf(run.scope).filter((p) => p !== pc);
  if (others.length !== 1)
    throw new Error("the operation needs exactly two peers in scope");
  return others[0];
};

function checkInvariants(run: Run, peers = peersOf(run.scope)) {
  for (const pc of peers) {
    if (pc.signalingState !== "closed") utils.assertNegotiationInvariants(pc);
  }
}

/** A description from a value of the steps: a description, an SDP string or `rollback`. */
function description(
  value: unknown,
  pc: RTCPeerConnection,
  side: "local" | "remote",
  type?: string,
): Description {
  if (value === "rollback") return { type: "rollback", sdp: "" };
  if (typeof value === "string") {
    const offering =
      side === "local"
        ? ["stable", "have-local-offer"].includes(pc.signalingState)
        : ["stable", "have-remote-offer"].includes(pc.signalingState);
    return { type: type ?? (offering ? "offer" : "answer"), sdp: value };
  }
  const d = value as Description;
  if (!d?.sdp && d?.type !== "rollback") throw new Error("not a description");
  return { type: type ?? d.type, sdp: d.sdp };
}

/** Run a description operation; `rejects` expects that error name and no state change. */
async function settle(
  run: Run,
  pc: RTCPeerConnection,
  operation: () => Promise<unknown>,
  rejects: string | undefined,
  message: string,
) {
  if (!rejects) {
    const result = await operation();
    if (!run.explicitInvariants) checkInvariants(run);
    return result;
  }
  const before = utils.negotiationSnapshot(pc);
  const error = await operation().then(
    () => undefined,
    (e: Error) => e,
  );
  expectRejection(error, rejects, message);
  if (pc.signalingState !== "closed") {
    expect(
      utils.negotiationSnapshot(pc),
      `${message}: a rejected operation changed state`,
    ).toEqual(before);
  }
  if (!run.explicitInvariants) checkInvariants(run);
}

async function descriptionOp(
  run: Run,
  pc: RTCPeerConnection,
  op: string,
  text: string,
  message: string,
) {
  const { rest, flags } = trailingFlags(text, ["restart", "hold"]);
  const value = async () =>
    rest === "rollback"
      ? "rollback"
      : rest
        ? evaluate(rest, run.scope)
        : undefined;
  const created = () => {
    const d = run.created.get(pc);
    if (!d) throw new Error("no description was created by this peer");
    return d;
  };
  const bind = (d: Description) => {
    run.created.set(pc, d);
    if (flags.as) run.scope[flags.as] = d;
  };
  const other = () => otherPeer(run, pc);
  const deliver = (from: RTCPeerConnection, to: RTCPeerConnection) =>
    settle(
      run,
      to,
      () => to.setRemoteDescription(from.localDescription!),
      undefined,
      message,
    );
  switch (op) {
    case "createOffer":
      return bind(await pc.createOffer({ iceRestart: !!flags.restart }));
    case "createAnswer":
      return bind(await pc.createAnswer());
    case "setLocal": {
      const d = description(
        rest ? await value() : created(),
        pc,
        "local",
        flags.type,
      );
      return settle(
        run,
        pc,
        () => pc.setLocalDescription(d as never),
        flags.rejects,
        message,
      );
    }
    case "setRemote": {
      const d = description(await value(), pc, "remote", flags.type);
      return settle(
        run,
        pc,
        () => pc.setRemoteDescription(d as never),
        flags.rejects,
        message,
      );
    }
    case "addCandidate":
      return settle(
        run,
        pc,
        async () => pc.addIceCandidate((await value()) as never),
        flags.rejects,
        message,
      );
    case "offer":
      bind(await pc.createOffer({ iceRestart: !!flags.restart }));
      await settle(
        run,
        pc,
        () => pc.setLocalDescription(created() as never),
        undefined,
        message,
      );
      return flags.hold ? undefined : deliver(pc, other());
    case "answer":
    case "pranswer": {
      bind(await pc.createAnswer());
      const d = { type: op, sdp: created().sdp };
      await settle(
        run,
        pc,
        () => pc.setLocalDescription(d as never),
        undefined,
        message,
      );
      return flags.hold ? undefined : deliver(pc, other());
    }
    case "negotiate":
      await descriptionOp(run, pc, "offer", text, message);
      return descriptionOp(run, other(), "answer", "", message);
    case "rollback":
      for (const peer of [pc, other()]) {
        if (
          ["have-local-offer", "have-remote-pranswer"].includes(
            peer.signalingState,
          )
        ) {
          await settle(
            run,
            peer,
            () => peer.setLocalDescription({ type: "rollback" } as never),
            undefined,
            message,
          );
        } else if (
          ["have-remote-offer", "have-local-pranswer"].includes(
            peer.signalingState,
          )
        ) {
          await settle(
            run,
            peer,
            () => peer.setRemoteDescription({ type: "rollback" } as never),
            undefined,
            message,
          );
        }
      }
      return;
    case "finish":
      // `finish answer`: answer the pending remote offer (delivered when the
      // peer waits for it); `finish rollback`: the rollback macro.
      if (rest === "rollback")
        return descriptionOp(run, pc, "rollback", "", message);
      bind(await pc.createAnswer());
      await settle(
        run,
        pc,
        () => pc.setLocalDescription(created() as never),
        undefined,
        message,
      );
      if (other().signalingState === "have-local-offer")
        await deliver(pc, other());
      return;
    case "close":
      return pc.close();
  }
}

/** Evaluate an expression of the steps and await its value. */
export async function evaluate(source: string, scope: Scope) {
  return await compile(source)(scope);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runStep(run: Run, line: string, message: string) {
  const scope = run.scope;
  const [head, ...words] = line.split(/\s+/);
  const tail = line.slice(head.length).trim();
  const label = `s${run.step}`;
  if (
    scope[head] instanceof RTCPeerConnection &&
    DESCRIPTION_OPS.has(words[0])
  ) {
    return descriptionOp(
      run,
      scope[head] as RTCPeerConnection,
      words[0],
      tail.slice(words[0].length),
      message,
    );
  }
  switch (head) {
    case "let": {
      // `let name = expression` or `let [x, y] = expression` (array elements)
      const m = tail.match(/^(\w+|\[[\w\s,]*\])\s*=\s*([\s\S]+)$/);
      if (!m) throw new Error("let needs `let name = expression`");
      const value = await evaluate(m[2], scope);
      if (!m[1].startsWith("[")) return void (scope[m[1]] = value);
      const names = m[1]
        .slice(1, -1)
        .split(",")
        .map((n) => n.trim());
      for (const [i, name] of names.entries()) {
        if (name) scope[name] = (value as unknown[])[i];
      }
      return;
    }
    case "start": {
      const m = tail.match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if (!m) throw new Error("start needs `start name = expression`");
      const promise = Promise.resolve(compile(m[2])(scope));
      promise.catch(() => undefined);
      scope[m[1]] = promise;
      return;
    }
    case "do":
      return void (await evaluate(tail, scope));
    case "await": {
      const { rest, flags } = trailingFlags(tail);
      const settled = evaluate(rest, scope);
      if (!flags.rejects) return void (await settled);
      const error = await settled.then(
        () => undefined,
        (e: Error) => e,
      );
      expectRejection(error, flags.rejects, message);
      return;
    }
    case "expect": {
      const parts = splitTop(tail, Object.keys(COMPARATORS));
      if (parts) {
        const [actual, comparator, expected] = parts;
        return COMPARATORS[comparator](
          await evaluate(actual, scope),
          await evaluate(expected, scope),
          message,
        );
      }
      const { rest, flags } = trailingFlags(tail);
      if (flags.rejects) {
        const error = await Promise.resolve()
          .then(() => evaluate(rest, scope))
          .then(
            () => undefined,
            (e: Error) => e,
          );
        expectRejection(error, flags.rejects, message);
        return;
      }
      throw new Error("expect needs a comparator or rejects=");
    }
    case "invariants":
      return checkInvariants(
        run,
        words.length
          ? words.map((w) => scope[w] as RTCPeerConnection)
          : undefined,
      );
    case "rtp":
    case "data": {
      const [from, to] = tail.split("->").map((part) => part.trim());
      const send =
        head === "rtp" ? utils.sendAndExpectRtp : utils.sendAndExpectData;
      return send(
        (await evaluate(from, scope)) as never,
        (await evaluate(to, scope)) as never,
        label,
      );
    }
    case "alive":
      return utils.expectSessionAlive(
        scope.session as utils.DuplexSession,
        label,
      );
    case "sleep":
      return sleep(Number(tail));
    case "waitFor": {
      const { rest, flags } = trailingFlags(tail);
      const condition = compile(rest);
      return utils.waitUntil(
        () => !!condition(scope),
        `${message}: never held`,
        Number(flags.timeout ?? 3000),
      );
    }
    case "exempt":
      run.exempt = tail;
      return utils.exemptFromContinuation(peersOf(scope), tail);
  }
  throw new Error(`unknown step "${line}"`);
}

/** Trimmed non-empty lines; a line with unclosed brackets continues on the next. */
function joinLines(text: string) {
  const lines: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    pending = pending ? `${pending} ${raw.trim()}` : raw.trim();
    const open =
      (pending.match(/[([{]/g) ?? []).length -
      (pending.match(/[)\]}]/g) ?? []).length;
    if (open > 0) continue;
    if (pending) lines.push(pending);
    pending = "";
  }
  return lines;
}

/** Lines of the steps for one parameter row: substituted and filtered. */
function stepLines(steps: string, row: CaseParams) {
  const text = steps.replace(/\$(\w+)/g, (m, key) =>
    key in row ? String(row[key]) : m,
  );
  return joinLines(text).flatMap((line) => {
    const condition = line.match(/^\[(\w+)(!?=)([^\]]+)\]\s*(.*)$/);
    if (!condition) return [line];
    const [, key, op, values, rest] = condition;
    const hit = values.split("|").includes(String(row[key]));
    return hit === (op === "=") ? [rest] : [];
  });
}

const HEADER = /^(case|ref|given|each|exempt|timeout|invariants):\s*(.*)$/;

function parseCase(input: CaseText): NegotiationCase {
  const { text, fns } = typeof input === "string" ? { text: input } : input;
  const lines = joinLines(text);
  const header: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(HEADER);
    if (!m) break;
    header[m[1]] = m[2];
  }
  if (!header.case || !header.ref || !header.given) {
    throw new Error(`a case needs case:, ref: and given: (${lines[0]})`);
  }
  return {
    name: header.case,
    ref: header.ref,
    given: header.given,
    each: header.each
      ? (compile(header.each)(baseScope()) as CaseParams[])
      : undefined,
    exempt: header.exempt,
    timeout: header.timeout ? Number(header.timeout) : undefined,
    explicitInvariants: header.invariants === "explicit",
    steps: lines.slice(i).join("\n"),
    fns,
  };
}

const LABEL = /^(Arrange|Act|Assert)( \/ (Act|Assert))?:/;

/** The base scope of the steps: globals, src, utils, then the domain and case helpers. */
function baseScope(...layers: (Scope | undefined)[]) {
  return Object.assign(
    Object.create(null),
    GLOBALS,
    werift,
    utils,
    {
      local: (pc: RTCPeerConnection) => pc.localDescription,
      remote: (pc: RTCPeerConnection) => pc.remoteDescription,
      sdpOf: (d: { sdp: string } | string) =>
        typeof d === "string" ? d : d.sdp,
      /** `each:` rows of a case that ends by the final answer or by rollback */
      ANSWER_OR_ROLLBACK: [{ finish: "answer" }, { finish: "rollback" }],
    },
    ...layers,
  ) as Scope;
}

/** Turn the value of `given` into scope variables (`a`, `b`, ...). */
function normalize(value: unknown, cleanup: (() => unknown)[]): Scope {
  if (value instanceof RTCPeerConnection) return { a: value };
  const { close, ...record } = value as Scope;
  if (typeof close === "function") cleanup.push(() => close.call(value));
  if (record.offerer instanceof RTCPeerConnection) {
    const { offerer, answerer, ...rest } = record;
    return { a: offerer, b: answerer, ...rest };
  }
  const session = value as utils.DuplexSession;
  if (
    session.a &&
    (session.a as { pc?: unknown }).pc instanceof RTCPeerConnection
  ) {
    const { a, b } = session;
    return {
      session,
      a: a.pc,
      b: b.pc,
      aOut: a.out,
      bOut: b.out,
      aVideo: a.video,
      bVideo: b.video,
      aChannel: a.channel,
      bChannel: b.channel,
    };
  }
  return record;
}

async function runCase(
  c: NegotiationCase,
  row: CaseParams,
  options: CaseOptions,
) {
  const caseName = c.name.replace(/\$(\w+)/g, (m, key) =>
    key in row ? String(row[key]) : m,
  );
  const run: Run = {
    scope: Object.create(baseScope(options.fns, c.fns)),
    caseName,
    created: new Map(),
    cleanup: [],
    explicitInvariants: !!c.explicitInvariants,
    step: 0,
  };
  run.scope.closing = <T>(value: T) => {
    const close = (value as { close?: () => unknown }).close;
    if (close) run.cleanup.push(() => close.call(value));
    return value;
  };
  const lines = stepLines(c.steps, row);
  const log: string[] = [];
  let phase = "";
  const fail = (error: unknown, where: string) => {
    const e = error instanceof Error ? error : new Error(String(error));
    e.message = [
      `case "${caseName}" (${c.ref})`,
      `${where}${phase ? `\n  phase: ${phase}` : ""}`,
      e.message,
      `steps run:\n${log.slice(-10).join("\n")}`,
    ].join("\n");
    return e;
  };
  try {
    try {
      Object.assign(
        run.scope,
        normalize(
          await evaluate(
            c.given.replace(/\$(\w+)/g, (m, key) =>
              key in row ? String(row[key]) : m,
            ),
            run.scope,
          ),
          run.cleanup,
        ),
      );
    } catch (error) {
      throw fail(error, `given: ${c.given}`);
    }
    if (c.exempt) {
      run.exempt = c.exempt;
      utils.exemptFromContinuation(peersOf(run.scope), c.exempt);
    }
    for (const [index, line] of lines.entries()) {
      run.step = index + 1;
      if (LABEL.test(line)) {
        phase = line;
        continue;
      }
      const where = `step ${run.step}/${lines.length}: ${line}`;
      log.push(`  ${run.step}. ${line}`);
      try {
        await runStep(run, line, `${caseName} — ${where}`);
      } catch (error) {
        throw fail(error, where);
      }
    }
    if (!run.exempt) {
      try {
        await utils.expectSessionContinues(
          run.scope.a as RTCPeerConnection,
          run.scope.b as RTCPeerConnection,
          "continue",
        );
      } catch (error) {
        throw fail(error, "expectSessionContinues after the last step");
      }
    }
  } finally {
    vi.restoreAllMocks();
    await Promise.allSettled([
      ...run.cleanup.map((close) => close()),
      ...peersOf(run.scope).map((pc) => pc.close()),
    ]);
  }
}

/**
 * Register declarative cases as tests of one describe block: one test per
 * case (per `each` row). Every case ends with `expectSessionContinues(a, b)`
 * unless it is exempt.
 */
export function negotiationCases(
  title: string,
  cases: CaseText[],
  options: CaseOptions = {},
) {
  describe(title, { timeout: options.timeout ?? 60_000 }, () => {
    utils.enforceSessionContinuation();
    for (const c of cases.map(parseCase)) {
      for (const row of c.each ?? [{}]) {
        const name = c.name.replace(/\$(\w+)/g, (m, key) =>
          key in row ? String(row[key]) : m,
        );
        test(name, { timeout: c.timeout ?? options.timeout ?? 60_000 }, () =>
          runCase(c, row, options),
        );
      }
    }
  });
}
