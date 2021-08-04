export function createTestTrack(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const drawAnimation = () => {
    ctx.save();
    ctx.fillStyle = "rgb(200, 200, 200)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const date = new Date();
    ctx.font = "38px Monaco,Consolas";
    ctx.textAlign = "center";
    ctx.fillStyle = "red";

    const hours = ("0" + date.getHours()).slice(-2);
    const minuites = ("0" + date.getMinutes()).slice(-2);
    const seconds = ("0" + date.getSeconds()).slice(-2);
    const milliseconds = ("00" + date.getMilliseconds()).slice(-3);
    ctx.fillText(
      `${hours}:${minuites}:${seconds}.${milliseconds}`,
      canvas.width / 2,
      85
    );
    ctx.restore();

    requestAnimationFrame(drawAnimation);
  };

  setTimeout(() => requestAnimationFrame(drawAnimation), 0);

  const [track] = (canvas as any).captureStream().getVideoTracks();
  return track as MediaStreamTrack;
}
