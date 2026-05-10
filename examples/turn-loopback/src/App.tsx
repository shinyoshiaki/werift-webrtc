import { useEffect, useMemo, useRef, useState } from "react";

type SessionConfig = {
  offer: RTCSessionDescriptionInit;
  turnUrl: string;
  username: string;
  password: string;
};

const defaultSignalingBaseUrl =
  import.meta.env.VITE_SIGNALING_BASE_URL ?? "https://127.0.0.1:8443";

export function App() {
  const [signalingBaseUrl, setSignalingBaseUrl] = useState(
    defaultSignalingBaseUrl,
  );
  const [status, setStatus] = useState("idle");
  const [connectionState, setConnectionState] = useState("new");
  const [turnUrl, setTurnUrl] = useState("");
  const [username, setUsername] = useState("");
  const [sentMessage, setSentMessage] = useState("");
  const [receivedMessage, setReceivedMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);

  useEffect(() => {
    return () => {
      channelRef.current?.close();
      peerRef.current?.close();
    };
  }, []);

  const canStart = useMemo(() => status !== "starting", [status]);

  async function startSession() {
    setStatus("starting");
    setConnectionState("new");
    setTurnUrl("");
    setUsername("");
    setSentMessage("");
    setReceivedMessage("");
    setErrorMessage("");

    channelRef.current?.close();
    peerRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;

    try {
      const config = await requestSession(signalingBaseUrl);
      setTurnUrl(config.turnUrl);
      setUsername(config.username);

      const peer = new RTCPeerConnection({
        iceServers: [
          {
            urls: config.turnUrl,
            username: config.username,
            credential: config.password,
          },
        ],
        iceTransportPolicy: "relay",
      });
      peerRef.current = peer;
      peer.onconnectionstatechange = () => {
        setConnectionState(peer.connectionState);
      };

      peer.ondatachannel = ({ channel }) => {
        channelRef.current = channel;
        channel.onopen = () => {
          const message = `echo-${config.username.slice(-8)}`;
          setSentMessage(message);
          setStatus("sending");
          channel.send(message);
        };
        channel.onmessage = async (event) => {
          setReceivedMessage(await readDataChannelMessage(event.data));
          setStatus("received");
        };
        channel.onclose = () => {
          setStatus((current) =>
            current === "received" ? "received" : "channel-closed",
          );
        };
      };

      await peer.setRemoteDescription(config.offer);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIceGatheringComplete(peer);
      await completeSession(signalingBaseUrl, config.username, peer.localDescription);
      setStatus("waiting-for-echo");
    } catch (error) {
      setStatus("failed");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="page">
      <section className="panel">
        <h1>werift TURN/TLS loopback</h1>
        <p className="lead">
          The browser answers a werift-generated offer and forces relay-only ICE
          through the server-provided <code>turns:</code> URL.
        </p>

        <label className="field">
          <span>HTTPS signaling base URL</span>
          <input
            value={signalingBaseUrl}
            onChange={(event) => setSignalingBaseUrl(event.target.value)}
            placeholder="https://127.0.0.1:8443"
          />
        </label>

        <button disabled={!canStart} onClick={() => void startSession()}>
          {status === "starting" ? "Starting..." : "Start echo session"}
        </button>

        <dl className="grid">
          <div>
            <dt>Status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Connection state</dt>
            <dd>{connectionState}</dd>
          </div>
          <div>
            <dt>TURN URL</dt>
            <dd>{turnUrl || "-"}</dd>
          </div>
          <div>
            <dt>Username</dt>
            <dd>{username || "-"}</dd>
          </div>
          <div>
            <dt>Sent echo</dt>
            <dd>{sentMessage || "-"}</dd>
          </div>
          <div>
            <dt>Received loopback</dt>
            <dd>{receivedMessage || "-"}</dd>
          </div>
        </dl>

        {errorMessage ? <pre className="error">{errorMessage}</pre> : null}
      </section>
    </main>
  );
}

async function requestSession(signalingBaseUrl: string): Promise<SessionConfig> {
  const response = await fetch(`${trimTrailingSlash(signalingBaseUrl)}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`POST /session failed: ${response.status}`);
  }
  return response.json() as Promise<SessionConfig>;
}

async function completeSession(
  signalingBaseUrl: string,
  username: string,
  answer: RTCSessionDescriptionInit | null,
) {
  if (!answer) {
    throw new Error("local answer is missing");
  }

  const response = await fetch(`${trimTrailingSlash(signalingBaseUrl)}/session`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      answer,
    }),
  });
  if (!response.ok) {
    throw new Error(`PUT /session failed: ${response.status}`);
  }
}

function waitForIceGatheringComplete(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      reject(new Error("ICE gathering did not complete in time"));
    }, 15_000);

    const handleIceGatheringStateChange = () => {
      if (peer.iceGatheringState !== "complete") {
        return;
      }
      clearTimeout(timer);
      peer.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      resolve();
    };

    peer.addEventListener(
      "icegatheringstatechange",
      handleIceGatheringStateChange,
    );
  });
}

async function readDataChannelMessage(data: string | Blob | ArrayBuffer) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return data.text();
  }
  return new TextDecoder().decode(data);
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
