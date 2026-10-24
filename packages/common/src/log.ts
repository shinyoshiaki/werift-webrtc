import { formatWithOptions } from "node:util";

export class WeriftError extends Error {
  message!: string;
  payload?: object;
  path?: string;

  constructor(props: Pick<WeriftError, "message" | "payload" | "path">) {
    super(props.message);
  }

  toJSON() {
    return {
      message: this.message,
      payload: JSON.parse(JSON.stringify(this.payload)),
      path: this.path,
    };
  }
}

export interface Debugger {
  (...args: unknown[]): void;
  readonly enabled: boolean;
  readonly namespace: string;
}

export interface DebugFactory {
  (namespace: string): Debugger;
  enable(namespaces: string): void;
  disable(): string;
  enabled(namespace: string): boolean;
}

let namespaceSetting = process.env.DEBUG ?? "";
let generation = 0;
let includePatterns: RegExp[] = [];
let excludePatterns: RegExp[] = [];
const colors = [31, 32, 33, 34, 35, 36];
let debugWriter: (message: string) => void = (message) => {
  process.stderr.write(message);
};

const compilePattern = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*?")}$`);

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function parseNamespaces(namespaces: string) {
  const tokens = namespaces.split(/[\s,]+/).filter(Boolean);
  includePatterns = tokens
    .filter((token) => !token.startsWith("-"))
    .map(compilePattern);
  excludePatterns = tokens
    .filter((token) => token.startsWith("-"))
    .map((token) => compilePattern(token.slice(1)));
}

parseNamespaces(namespaceSetting);

function isEnabled(namespace: string) {
  return (
    !excludePatterns.some((pattern) => pattern.test(namespace)) &&
    includePatterns.some((pattern) => pattern.test(namespace))
  );
}

function colorFor(namespace: string) {
  let hash = 0;
  for (let i = 0; i < namespace.length; i++)
    hash = (hash << 5) - hash + namespace.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}

function colorsEnabled() {
  if (process.env.NO_COLOR !== undefined) return false;
  const setting = process.env.DEBUG_COLORS;
  if (setting !== undefined)
    return !["no", "false", "0", "disabled"].includes(setting.toLowerCase());
  return Boolean(process.stderr.isTTY);
}

function write(namespace: string, args: unknown[], elapsed: number) {
  const message = formatWithOptions({ colors: false }, ...args);
  if (process.stderr.isTTY && colorsEnabled()) {
    const color = colorFor(namespace);
    debugWriter(
      `  \u001b[${color}m${namespace}\u001b[0m ${message} +${elapsed}ms\n`,
    );
  } else {
    debugWriter(`${new Date().toISOString()} ${namespace} ${message}\n`);
  }
}

const debugFactory = ((namespace: string) => {
  let checkedGeneration = -1;
  let enabledCache = false;
  let lastTime = Date.now();
  const logger = ((...args: unknown[]) => {
    if (checkedGeneration !== generation) {
      enabledCache = isEnabled(namespace);
      checkedGeneration = generation;
    }
    if (!enabledCache) return;
    const now = Date.now();
    write(namespace, args, now - lastTime);
    lastTime = now;
  }) as Debugger;
  Object.defineProperties(logger, {
    enabled: { get: () => debugFactory.enabled(namespace) },
    namespace: { value: namespace, enumerable: true },
  });
  return logger;
}) as DebugFactory;

debugFactory.enable = (namespaces: string) => {
  namespaceSetting = namespaces;
  parseNamespaces(namespaces);
  generation++;
};
debugFactory.disable = () => {
  const previous = namespaceSetting;
  debugFactory.enable("");
  return previous;
};
debugFactory.enabled = (namespace: string) => isEnabled(namespace);

export const debug = debugFactory;

/** @internal Replace the log sink in unit tests. */
export function setDebugWriterForTest(writer?: (message: string) => void) {
  debugWriter =
    writer ??
    ((message) => {
      process.stderr.write(message);
    });
}
