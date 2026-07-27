export class CliError extends Error {
  readonly exitCode: 1 | 2 | 3;

  constructor(message: string, exitCode: 1 | 2 | 3 = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class AuthenticationError extends CliError {
  constructor(message = "Authentication required. Run `aleph login`.") {
    super(message, 2);
    this.name = "AuthenticationError";
  }
}

export class ApiError extends CliError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
