export class SrtpAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SrtpAuthenticationError";
  }
}
