/** An api answer with a non-2xx status. `payload` is the parsed JSON body, or the raw text when the body is not JSON. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}
