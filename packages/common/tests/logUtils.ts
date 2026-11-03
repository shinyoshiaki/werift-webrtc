type DebugWriter = (...args: unknown[]) => void;

// 出力先は共有ロガー状態に保持されているため、公開 API を増やさずテストから差し替える
function logState() {
  return (globalThis as any)[Symbol.for("werift-common.log.state")] as {
    debugWriter: DebugWriter;
  };
}

export function createDebugOutput() {
  const messages: unknown[][] = [];
  const original = logState().debugWriter;
  logState().debugWriter = (...message) => messages.push(message);
  return {
    messages,
    restore: () => {
      logState().debugWriter = original;
    },
  };
}

export function setStderrIsTTYForTest(value: boolean) {
  const original = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value,
  });
  return () => {
    if (original) Object.defineProperty(process.stderr, "isTTY", original);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  };
}
