const started = Date.now();

function stamp(): string {
  const s = ((Date.now() - started) / 1000).toFixed(1).padStart(5, " ");
  return `[+${s}s]`;
}

export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`${stamp()} ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`${stamp()} ⚠️  ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`${stamp()} 🔴 ${msg}`, ...rest),
  step: (msg: string) => console.log(`\n${stamp()} ── ${msg}`),
};
