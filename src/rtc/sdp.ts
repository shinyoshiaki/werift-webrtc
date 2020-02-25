export class SessionDescription {
  version = 0;
  origin?: string;
  name = "-";
  time = "0 0";
  host?: string;
  group: GroupDescription[] = [];
  msidSemantic: GroupDescription[] = [];
  media = [];
  type?: string;
}

export class GroupDescription {
  constructor(private semantic: string, private items: (number | string)[]) {}

  str() {
    return `${this.semantic} ${this.items.join(" ")}`;
  }
}
