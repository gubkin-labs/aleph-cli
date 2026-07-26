export interface Output {
  data(value: unknown): void;
  error(message: string): void;
  readonly json: boolean;
  progress(message: string): void;
}

export const createOutput = (json: boolean): Output => ({
  json,
  data(value): void {
    if (json) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
      return;
    }
    process.stdout.write(
      `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`
    );
  },
  error(message): void {
    process.stderr.write(`${message}\n`);
  },
  progress(message): void {
    if (!json) {
      process.stderr.write(`${message}\n`);
    }
  },
});
