export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "request_error",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
