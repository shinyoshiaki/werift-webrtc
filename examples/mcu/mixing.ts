export class Mixer {
  private inputs: { [id: string]: Input } = {};
  private pcmMap: { [id: string]: Buffer } = {};
  onData: (buf: Buffer) => void = () => {};

  constructor() {}

  input() {
    const input = new Input(this);
    this.inputs[input.id] = input;

    return input;
  }

  write(id: string, buf: Buffer) {
    this.pcmMap[id] = buf;
    this.merge();
  }

  private merge() {
    if (Object.keys(this.pcmMap).length >= Object.keys(this.inputs).length) {
      const inputs = Object.values(this.pcmMap);
      const base = inputs.shift();
      this.pcmMap = {};
      const res = inputs.reduce(
        (acc: number[], cur) => {
          const next = acc.map((v, i) => this.mix(v, cur[i]));
          return next;
        },
        [...base]
      );
      this.onData(Buffer.from(res));
    }
  }

  private mix(a: number, b: number) {
    const res = a + b;
    const max = 1 << (16 - 1);
    if (max < res) {
      return max;
    } else {
      return res;
    }
  }

  remove(id: string) {
    delete this.inputs[id];
    delete this.pcmMap[id];
  }
}

export class Input {
  id = Math.random().toString();
  constructor(private mixer: Mixer) {}

  write(buf: Buffer) {
    this.mixer.write(this.id, buf);
  }

  remove() {
    this.mixer.remove(this.id);
  }
}
