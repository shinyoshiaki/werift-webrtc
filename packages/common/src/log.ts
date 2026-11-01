export class WeriftError extends Error {
  // `declare` keeps the message set by Error: a class field would overwrite it
  // with undefined under useDefineForClassFields
  declare message: string;
  payload?: object;
  path?: string;

  constructor(props: Pick<WeriftError, "message" | "payload" | "path">) {
    super(props.message);
    this.payload = props.payload;
    this.path = props.path;
  }

  toJSON() {
    return {
      message: this.message,
      payload:
        this.payload === undefined
          ? undefined
          : JSON.parse(JSON.stringify(this.payload)),
      path: this.path,
    };
  }
}

export interface Debugger {
  (...args: unknown[]): void;
  enabled: boolean;
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

type LogState = {
  namespaceSetting: string;
  generation: number;
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
  lastTime: number;
  debugWriter: (...args: unknown[]) => void;
};

// ESM の各バンドル（werift / werift/nonstandard など）にこのモジュールが複製されても
// 設定を共有できるよう、状態はグローバルに 1 つだけ持つ
const stateKey = Symbol.for("werift-common.log.state");
const state: LogState = ((globalThis as any)[stateKey] ??= {
  namespaceSetting: initialNamespaces(),
  generation: 0,
  includePatterns: [],
  excludePatterns: [],
  lastTime: Date.now(),
  debugWriter: (...args: unknown[]) => writeToConsole(...args),
} satisfies LogState);

if (state.generation === 0 && state.includePatterns.length === 0)
  parseNamespaces(state.namespaceSetting);

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
  state.includePatterns = tokens
    .filter((token) => !token.startsWith("-"))
    .map(compilePattern);
  state.excludePatterns = tokens
    .filter((token) => token.startsWith("-"))
    .map((token) => compilePattern(token.slice(1)));
}

function isEnabled(namespace: string) {
  return (
    !state.excludePatterns.some((pattern) => pattern.test(namespace)) &&
    state.includePatterns.some((pattern) => pattern.test(namespace))
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
  const elapsed = now - state.lastTime;
  state.lastTime = now;

  if (isNodeRuntime()) {
    const prefix = colorsEnabled(process)
      ? `\u001b[${colorFor(namespace)}m${namespace}\u001b[0m`
      : `${new Date().toISOString()} ${namespace}`;
    const suffix = colorsEnabled(process) ? ` +${elapsed}ms` : "";
    const output = [...args];
    if (typeof output[0] === "string")
      output[0] = `${prefix} ${output[0]}${suffix}`;
    else output.unshift(`${prefix}${suffix}`);
    state.debugWriter(...output);
    return;
  }

  const output = [...args];
  if (typeof output[0] === "string") output[0] = `${namespace} ${output[0]}`;
  else output.unshift(namespace);
  state.debugWriter(...output);
}

const debugFactory = ((namespace: string) => {
  let checkedGeneration = -1;
  let enabledCache = false;
  let override: boolean | undefined;
  const isLoggerEnabled = () => {
    if (override !== undefined) return override;
    if (checkedGeneration !== state.generation) {
      enabledCache = isEnabled(namespace);
      checkedGeneration = state.generation;
    }
    return enabledCache;
  };
  const logger = ((...args: unknown[]) => {
    if (isLoggerEnabled()) emit(namespace, args);
  }) as Debugger;
  Object.defineProperties(logger, {
    enabled: {
      get: isLoggerEnabled,
      set: (value: boolean) => {
        override = Boolean(value);
      },
      enumerable: true,
    },
    namespace: { value: namespace, enumerable: true },
  });
  return logger;
}) as DebugFactory;

debugFactory.enable = (namespaces: string) => {
  state.namespaceSetting = namespaces;
  parseNamespaces(namespaces);
  state.generation++;
};
debugFactory.disable = () => {
  const previous = state.namespaceSetting;
  debugFactory.enable("");
  return previous;
};
debugFactory.enabled = (namespace: string) => isEnabled(namespace);

export const debug = debugFactory;
