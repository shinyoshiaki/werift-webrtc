export async function getVideoStream(ab: ArrayBuffer) {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(new Blob([ab]));
  video.muted = true;
  video.loop = true;
  video.style.display = "none";
  video.play();
  document.body.appendChild(video);

  await new Promise((r) => video.addEventListener("loadeddata", r));

  const [track] = (video as any).captureStream().getVideoTracks();

  const stream = new MediaStream([track]);
  return { stream };
}
