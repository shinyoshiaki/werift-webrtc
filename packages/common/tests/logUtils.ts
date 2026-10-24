import { setDebugWriterForTest } from "../src/log";

export function createDebugOutput() {
  const messages: unknown[][] = [];
  setDebugWriterForTest((...message) => messages.push(message));
  return {
    messages,
    restore: () => setDebugWriterForTest(),
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
