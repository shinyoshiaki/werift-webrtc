from aiortc import (RTCPeerConnection, RTCSessionDescription)
from aioice import (Candidate)
import asyncio
import websockets
import json
import logging

# logging.basicConfig(level=logging.DEBUG)

WEBSOCKET_URI = "ws://127.0.0.1:8766"


def object_from_string(message_str):
    message = json.loads(message_str)
    if message["type"] in ["answer", "offer"]:
        return RTCSessionDescription(**message)


def object_to_string(obj):
    if isinstance(obj, RTCSessionDescription):
        message = {"sdp": obj.sdp, "type": obj.type}
    return message


async def main():
    websocket = await websockets.connect(WEBSOCKET_URI)

    pc = RTCPeerConnection()

    @pc.on("datachannel")
    def on_datachannel(channel):
        print(channel, "-", "created by remote party")
        channel.send("ping")

    message = await websocket.recv()
    print(message)
    await pc.setRemoteDescription(object_from_string(message))
    print("set")
    answer = await pc.createAnswer()
    print(answer)
    await pc.setLocalDescription(answer)
    prepare = object_to_string(pc.localDescription)
    string = json.dumps(
        prepare
    )
    print(prepare, string)
    await websocket.send(string)
    print("sent")
    await websocket.close()

    await asyncio.sleep(10)


asyncio.get_event_loop().run_until_complete(main())
