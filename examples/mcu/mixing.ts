export class Mixer {
  inputs: { [id: string]: Input } = {};
  pcmList: { [id: string]: Buffer } = {};
  onData: (buf: Buffer) => void = () => {};

  constructor() {}

  input() {
    const input = new Input(this);
    this.inputs[input.id] = input;

    return input;
  }

  write(id: string, buf: Buffer) {
    this.pcmList[id] = buf;
    this.merge();
  }

  private merge() {
    if (Object.keys(this.pcmList).length >= Object.keys(this.inputs).length) {
      const inputs = Object.values(this.pcmList);
      const base = inputs.shift();
      this.pcmList = {};
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
    } else if (0 > res) {
      return res;
    }
    return res;
  }

  remove(id: string) {
    delete this.inputs[id];
    delete this.pcmList[id];
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
