class LatencyBudgetPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = sampleRate * 12;
    this.buffer = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "clear") {
        this.readIndex = this.writeIndex = 0;
      } else if (data.type === "samples") {
        const samples = data.samples;
        for (let i = 0; i < samples.length; i++) {
          const next = (this.writeIndex + 1) % this.capacity;
          if (next === this.readIndex)
            this.readIndex = (this.readIndex + 1) % this.capacity;
          this.buffer[this.writeIndex] = samples[i];
          this.writeIndex = next;
        }
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0][0];
    for (let i = 0; i < output.length; i++) {
      if (this.readIndex === this.writeIndex) {
        output[i] = 0;
      } else {
        output[i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
    }
    return true;
  }
}
registerProcessor("latency-budget-player", LatencyBudgetPlayer);
