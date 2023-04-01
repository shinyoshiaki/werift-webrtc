export async function getVideoStream(ab: ArrayBuffer) {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(new Blob([ab]));
  video.volume = 0.001;
  video.loop = true;
  await video.play();

  const stream = (video as any).captureStream();

  return stream as MediaStream;
}
