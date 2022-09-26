export class WeriftError extends Error {
  message!: string;
  payload?: object;
  path?: string;

  constructor(props: Pick<WeriftError, "message" | "payload" | "path">) {
    super(props.message);
  }

  toJSON() {
    return {
      message: this.message,
      payload: JSON.parse(JSON.stringify(this.payload)),
      path: this.path,
    };
  }
}
