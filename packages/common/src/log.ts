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

type RuntimeProcess = {
  env?: Record<string, string | undefined>;
  versions?: { node?: string };
  stderr?: { isTTY?: boolean };
};

const colors = [31, 32, 33, 34, 35, 36];
let namespaceSetting = initialNamespaces();
let generation = 0;
let includePatterns: RegExp[] = [];
let excludePatterns: RegExp[] = [];
let lastTime = Date.now();
let debugWriter: (...args: unknown[]) => void = (...args) => {
  writeToConsole(...args);
};

parseNamespaces(namespaceSetting);

function runtimeProcess() {
  return (globalThis as typeof globalThis & { process?: RuntimeProcess })
    .process;
}

function isNodeRuntime() {
  return Boolean(runtimeProcess()?.versions?.node);
}

function initialNamespaces() {
  if (isNodeRuntime()) return runtimeProcess()?.env?.DEBUG ?? "";
  try {
    return globalThis.localStorage?.getItem("debug") ?? "";
  } catch {
    return "";
  }
}

function compilePattern(pattern: string) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*?")}$`);
}

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

function colorsEnabled(process: RuntimeProcess | undefined) {
  if (process?.env?.NO_COLOR !== undefined) return false;
  const setting = process?.env?.DEBUG_COLORS;
  if (setting !== undefined)
    return !["no", "false", "0", "disabled"].includes(setting.toLowerCase());
  return Boolean(process?.stderr?.isTTY);
}

function writeToConsole(...args: unknown[]) {
  if (isNodeRuntime()) console.error(...args);
  else console.debug(...args);
}

function emit(namespace: string, args: unknown[]) {
  const process = runtimeProcess();
  const now = Date.now();
  const elapsed = now - lastTime;
  lastTime = now;

  if (isNodeRuntime()) {
    const prefix = process?.stderr?.isTTY && colorsEnabled(process)
      ? `\u001b[${colorFor(namespace)}m${namespace}\u001b[0m`
      : `${new Date().toISOString()} ${namespace}`;
    const suffix = process?.stderr?.isTTY && colorsEnabled(process)
      ? ` +${elapsed}ms`
      : "";
    const output = [...args];
    if (typeof output[0] === "string") output[0] = `${prefix} ${output[0]}${suffix}`;
    else output.unshift(`${prefix}${suffix ? ` ${suffix}` : ""}`);
    debugWriter(...output);
    return;
  }

  const output = [...args];
  if (typeof output[0] === "string") output[0] = `${namespace} ${output[0]}`;
  else output.unshift(namespace);
  debugWriter(...output);
}

const debugFactory = ((namespace: string) => {
  let checkedGeneration = -1;
  let enabledCache = false;
  const logger = ((...args: unknown[]) => {
    if (checkedGeneration !== generation) {
      enabledCache = isEnabled(namespace);
      checkedGeneration = generation;
    }
    if (enabledCache) emit(namespace, args);
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

/** @internal Replace the console sink in unit tests. */
export function setDebugWriterForTest(writer?: (...args: unknown[]) => void) {
  debugWriter = writer ?? writeToConsole;
}
