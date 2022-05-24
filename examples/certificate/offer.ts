import {
  RTCPeerConnection,
  useAbsSendTime,
  useSdesMid,
} from "../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesMid(), useAbsSendTime()],
    },
    dtls: {
      keys: {
        keyPem: `-----BEGIN PRIVATE KEY-----
    MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCKvMLwIPKkl+a
    XiOvUi0omy1IkfdJWquUbddm9crY5s1svS+ImW/zfLCWFyGXhtgkK5vOg3cFuKb3
    8vBtp+WrJCZZHfmZtwd+5I/GPRgkHff9cJar7phLSBMzG/+TzHPEc7KnZnBJjGFf
    IEjPfslXIgV5ktm4ZQ0t6VU0/87oTyITb9At8uj3KTNPC4Si5HfUlTGWEiovMO7D
    Skz5G2zS/LiL00W/UpNXWJ6Z7+Oxp5SguvQuoNCPJ7c6dvSJ+R/iNFXrZXnsYwSP
    +uKoeHh3/g8fa1689JZzwcmPXVU18777imHkeC5LLLUq5+5rGengT+0HUO5umQ8t
    yDwcQqBlAgMBAAECggEAb2qByI6RkV3oqgW26FV5QEG6/Fd11IvIxQU6gwQrf8cA
    vZLZgcK58LfuBFIFnpNr12WGpDvfwlKwzLqEqAedzFSUBLMklMXn8TJqJdDM13yy
    3qUKcGIa1afoDH3WbBL3oxTYwSIQ8MMy5Ij7/sS799m31okjkaG6rEul7yGSss4j
    6VnYhKnIoRysOme0fvQggrdcD7a72pJCPESKRUyQ/vtOpI9wEKx5ZiE1kPmZKYi1
    orNA6ni8vYXPVkVuUiQwKUiBILBnvOU89WmJ5HkirXk2EJFHZ1oJAjH+69H9ooRv
    XOg65qg/gL17NSCMfJXvTZ7AjZzD3tI6tzWrPW6mSQKBgQD8MOsnoVtcemJdVjnI
    AbkwIVPm40AnEdvI36sOiyLOX7cp9vaj/T5hKKFuT+5hbrSVOSblP1v6sKTN7GeK
    9XSpnqav39sLls16l7VXYJ8YviuGBY20bvgr38S3PcASdkcOe138ZwHrrAY6IoOi
    8wnCifsDBBPS37GEl/i+PAhFnwKBgQDFGa/tYeTN4xVbblRZ/8Y/eJpox6+/HPbY
    mBTi1/UCTf3/94O1gzOsTbZjLh1go4UsHqovYXWAEQ8/Uq8cTiAM5vRGSKI9jpwv
    GZH4DLL/3A0HMI1806WUD5rDxqeqi30GUc3UOitnm0NtFkfUKwAMTRm3L5m7pPkz
    9S4OsIWzewKBgBJa9SKjSeUHO1WTywzVo0bvhg3OCINPd3G9ZdPfKJ9gtBIn2XfC
    HOIxdN50juMkjZw21q/k1qr+ZGBgjoC8sMsPsw4l+ulzBm2f0SEU9T91x/EvQksZ
    sJJw7P5xTiOJ3E4fiI2waaFfmextSqt3iQRRyqVDjLXSdjcyYHZoJCn9AoGBAIE6
    U0+nxJV9Eu6sit+rRHcvAsY6Tq9WNT5TkDYe88Q8EJI33YIv8LxDA5dJj/dhnxoL
    TPfdxWVfSgjxlGBRlNAAyR4f10fW7e4vrLXe1anNxDj3i3zRY5mNFaLQ5/N4m1N+
    ZR6FuRmoAfBPEG86dkCaeIbTzc7q3n1Dfpwg/rhrAoGAdro9cePKr2j77ToUz5CM
    /ETVJQTG0UZ6tsE1Z+8Bm4SqTOpcrcB7xO6MM2eTth37FpkR/yclng0kNlvwXWB9
    p731uFwJTQeB6AMwXVQQa/gJP3LKClmsukdUv40QhjgsacGYEhKlI3LEhq5JffTO
    flOg0UgMLR8aG02VfHtHxCs=
    -----END PRIVATE KEY-----`,
        certPem: `-----BEGIN CERTIFICATE-----
    MIIDBzCCAe+gAwIBAgIBATANBgkqhkiG9w0BAQsFADBFMQswCQYDVQQGEwJBVTET
    MBEGA1UECBMKU29tZS1TdGF0ZTEhMB8GA1UEChMYSW50ZXJuZXQgV2lkZ2l0cyBQ
    dHkgTHRkMB4XDTIyMDUyNDExNDQ1N1oXDTMyMDUyNDExNDQ1N1owRTELMAkGA1UE
    BhMCQVUxEzARBgNVBAgTClNvbWUtU3RhdGUxITAfBgNVBAoTGEludGVybmV0IFdp
    ZGdpdHMgUHR5IEx0ZDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMIq
    8wvAg8qSX5peI69SLSibLUiR90laq5Rt12b1ytjmzWy9L4iZb/N8sJYXIZeG2CQr
    m86DdwW4pvfy8G2n5askJlkd+Zm3B37kj8Y9GCQd9/1wlqvumEtIEzMb/5PMc8Rz
    sqdmcEmMYV8gSM9+yVciBXmS2bhlDS3pVTT/zuhPIhNv0C3y6PcpM08LhKLkd9SV
    MZYSKi8w7sNKTPkbbNL8uIvTRb9Sk1dYnpnv47GnlKC69C6g0I8ntzp29In5H+I0
    VetleexjBI/64qh4eHf+Dx9rXrz0lnPByY9dVTXzvvuKYeR4LksstSrn7msZ6eBP
    7QdQ7m6ZDy3IPBxCoGUCAwEAAaMCMAAwDQYJKoZIhvcNAQELBQADggEBAEw45+nF
    fb+2o90/Bk/Ti/3QUjZBDGif2c1Tu2AB4gA2dvMxgoGfGE4q9dVMQmrempo/pcVZ
    8qtIOw27hr7xbSUEtKKoY0qY0jMeftBCeqoaYigr572wsd3owBI2DXF1HtBDRBfL
    MjwusOrbXIQKvHxCYz4pac3WnpFe/QUaLBpb9o94fbXmefRlJGsciLrRqWQ9IMtR
    UH4qNMUHA4UhglH4AFvAs2rah1sxutv3zf5y+GCAmPyYoEYpAwy/TAHiSe88CjWU
    7f+EaCDNn/cSK655g64OfQJoz6d2UbM35niAtCKAuRQSvC6k+Q6xe5bLL7LNpsiC
    hLKscDcm5xJHyrM=
    -----END CERTIFICATE-----`,
        signatureHash: { signature: 1, hash: 4 },
      },
    },
  });

  const video = pc.addTransceiver("video");
  video.onTrack.subscribe((track) => {
    video.sender.replaceTrack(track);
    video.sender.onPictureLossIndication.subscribe(() =>
      video.receiver.sendRtcpPLI(track.ssrc)
    );
  });

  const audio = pc.addTransceiver("audio");
  audio.onTrack.subscribe((track) => {
    audio.sender.replaceTrack(track);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
