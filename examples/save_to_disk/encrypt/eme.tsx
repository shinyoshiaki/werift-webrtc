/* eslint-disable @typescript-eslint/ban-ts-comment */
import React, { FC, useRef } from "react";
import ReactDOM from "react-dom";

function toBase64(u8arr) {
  "use strict";
  return btoa(String.fromCharCode.apply(null, u8arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=*$/, "");
}

function generateLicense(message: ArrayBuffer) {
  "use strict";
  // Parse the clearkey license request.
  const request = JSON.parse(new TextDecoder().decode(message));
  // We expect to only have one key requested at a time
  if (request.kids.length != 1) {
    console.log(
      `Got more than one key requested (got ${request.kids.length})! We don't expect this!`
    );
  }

  // Create our clear key object, looking up the key based on the key id
  const keyObj = {
    kty: "oct",
    alg: "A128KW",
    kid: request.kids[0],
    k: toBase64(
      new Uint8Array([
        0xef, 0xac, 0xdf, 0x21, 0xef, 0xbd, 0xaa, 0xe1, 0xd3, 0x81, 0xa4, 0x56,
        0x94, 0xf4, 0x5f, 0x5e,
      ])
    ),
  };
  return new TextEncoder().encode(
    JSON.stringify({
      keys: [keyObj],
    })
  );
}

const App: FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const onFile = async (file: File) => {
    const elm = videoRef.current!;

    const keySystemAccess = await navigator.requestMediaKeySystemAccess(
      "org.w3.clearkey",
      [
        {
          initDataTypes: ["webm"],
          videoCapabilities: [{ contentType: `video/webm; codecs="vp8"` }],
          audioCapabilities: [{ contentType: `audio/webm; codecs="opus"` }],
        },
      ]
    );
    const mediaKeys = await keySystemAccess.createMediaKeys();
    await elm.setMediaKeys(mediaKeys);
    elm.onencrypted = (e) => {
      const session = mediaKeys.createSession();
      session.onmessage = (e) => {
        const license = generateLicense(e.message);
        session.update(license).catch((failureReason) => {
          console.log("update() failed: " + failureReason.message);
        });
      };
      return session.generateRequest(e.initDataType, e.initData);
    };

    const ab = await file.arrayBuffer();
    const mediaSource = new MediaSource();
    elm.src = URL.createObjectURL(mediaSource);
    await new Promise((r) => (mediaSource.onsourceopen = r));

    const sourceBuffer = mediaSource.addSourceBuffer(
      `video/webm;codecs="vp8,opus"`
    );
    sourceBuffer.appendBuffer(ab);
  };

  return (
    <div>
      <input
        type="file"
        onChange={(e) =>
          onFile(e.target.files![0]).catch((e) => {
            console.log(e);
          })
        }
      />
      <video autoPlay controls ref={videoRef} />
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));
