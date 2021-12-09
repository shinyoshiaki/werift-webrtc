export async function getAudioStream(ab, gain) {
  const ctx: AudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)();

  const audioBuffer = await ctx.decodeAudioData(ab);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = true;
  source.start();
  const destination = ctx.createMediaStreamDestination();
  const gainNode = ctx.createGain();
  source.connect(gainNode);
  gainNode.connect(destination);
  gainNode.gain.value = gain;

  return { stream: destination.stream, gainNode, ctx };
}

export function uint32Add(a: number, b: number) {
  return Number((BigInt(a) + BigInt(b)) & 0xffffffffn);
}
