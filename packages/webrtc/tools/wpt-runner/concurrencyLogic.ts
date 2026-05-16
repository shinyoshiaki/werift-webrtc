export function resolveTargetConcurrency(input: {
  availableParallelism?: number;
  cpuCount?: number;
  input?: string;
}) {
  const configured = parsePositiveInteger(input.input);
  if (configured) {
    return configured;
  }

  const detected = normalizeConcurrency(input.availableParallelism)
    ?? normalizeConcurrency(input.cpuCount)
    ?? 1;

  return detected;
}

function parsePositiveInteger(value?: string) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return normalizeConcurrency(parsed);
}

function normalizeConcurrency(value?: number) {
  if (!value || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.max(1, Math.floor(value));
}
