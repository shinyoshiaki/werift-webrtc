Object.defineProperty(exports, "__esModule", { value: true });
exports.debug = exports.WeriftError = void 0;
exports.setDebugWriterForTest = setDebugWriterForTest;
const node_util_1 = require("node:util");
class WeriftError extends Error {
  constructor(props) {
    super(props.message);
    Object.defineProperty(this, "message", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "payload", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "path", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
  }
  toJSON() {
    return {
      message: this.message,
      payload: JSON.parse(JSON.stringify(this.payload)),
      path: this.path,
    };
  }
}
exports.WeriftError = WeriftError;
let namespaceSetting = process.env.DEBUG ?? "";
let generation = 0;
let includePatterns = [];
let excludePatterns = [];
const colors = [31, 32, 33, 34, 35, 36];
let debugWriter = (message) => {
  process.stderr.write(message);
};
const compilePattern = (pattern) =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*?")}$`);
function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function parseNamespaces(namespaces) {
  const tokens = namespaces.split(/[\s,]+/).filter(Boolean);
  includePatterns = tokens
    .filter((token) => !token.startsWith("-"))
    .map(compilePattern);
  excludePatterns = tokens
    .filter((token) => token.startsWith("-"))
    .map((token) => compilePattern(token.slice(1)));
}
parseNamespaces(namespaceSetting);
function isEnabled(namespace) {
  return (
    !excludePatterns.some((pattern) => pattern.test(namespace)) &&
    includePatterns.some((pattern) => pattern.test(namespace))
  );
}
function colorFor(namespace) {
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
function write(namespace, args, elapsed) {
  const message = (0, node_util_1.formatWithOptions)(
    { colors: false },
    ...args,
  );
  if (process.stderr.isTTY && colorsEnabled()) {
    const color = colorFor(namespace);
    debugWriter(
      `  \u001b[${color}m${namespace}\u001b[0m ${message} +${elapsed}ms\n`,
    );
  } else {
    debugWriter(`${new Date().toISOString()} ${namespace} ${message}\n`);
  }
}
const debugFactory = (namespace) => {
  let checkedGeneration = -1;
  let enabledCache = false;
  let lastTime = Date.now();
  const logger = (...args) => {
    if (checkedGeneration !== generation) {
      enabledCache = isEnabled(namespace);
      checkedGeneration = generation;
    }
    if (!enabledCache) return;
    const now = Date.now();
    write(namespace, args, now - lastTime);
    lastTime = now;
  };
  Object.defineProperties(logger, {
    enabled: { get: () => debugFactory.enabled(namespace) },
    namespace: { value: namespace, enumerable: true },
  });
  return logger;
};
debugFactory.enable = (namespaces) => {
  namespaceSetting = namespaces;
  parseNamespaces(namespaces);
  generation++;
};
debugFactory.disable = () => {
  const previous = namespaceSetting;
  debugFactory.enable("");
  return previous;
};
debugFactory.enabled = (namespace) => isEnabled(namespace);
exports.debug = debugFactory;
/** @internal Replace the log sink in unit tests. */
function setDebugWriterForTest(writer) {
  debugWriter =
    writer ??
    ((message) => {
      process.stderr.write(message);
    });
}
//# sourceMappingURL=log.js.map
