export class Mixer {
  inputs: { [id: string]: Input } = {};
  pcm: { [id: string]: Buffer } = {};
  onData: (buf: Buffer) => void = () => {};

  constructor() {}

  input() {
    const input = new Input(this);
    this.inputs[input.id] = input;

    return input;
  }

  mixing() {
    if (Object.keys(this.pcm).length >= Object.keys(this.inputs).length) {
      const inputs = Object.values(this.pcm);
      const base = inputs.shift();
      this.pcm = {};
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

  write(id: string, buf: Buffer) {
    this.pcm[id] = buf;
    this.mixing();
  }

  remove(id: string) {
    delete this.inputs[id];
    delete this.pcm[id];
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
