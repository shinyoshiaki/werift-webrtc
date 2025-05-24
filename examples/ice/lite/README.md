# ICE Lite Server/Client Example

This example demonstrates a simple ICE Lite server and a full ICE client setup using `RTCIceTransport`.

## How to Run

1.  **Open two terminal windows.**

2.  **In the first terminal, run the ICE Lite server:**
    ```bash
    npx ts-node examples/ice/lite/server.ts
    ```
    The server will start and print its local ICE parameters (uFrag and password) to the console. It will then wait for the client's parameters.

3.  **In the second terminal, run the full ICE client:**
    ```bash
    npx ts-node examples/ice/lite/client.ts
    ```
    The client will start and ask for the server's ICE uFrag and password.

4.  **Copy the server's uFrag and password** from the first terminal and paste them into the client's prompts in the second terminal.

5.  The client will then print its own local ICE parameters (uFrag and password) and its ICE candidates to the console. It will then wait for the server to receive these details.

6.  **Copy the client's uFrag, password, and all candidates** from the second terminal and paste them into the server's prompts in the first terminal. Candidates should be pasted one by one. After pasting the last candidate, enter an empty line to signal the end of candidates.

7.  Once both sides have the necessary information, they will attempt to establish an ICE connection.

8.  **Observe the console output** in both terminals. Both the client and server should log messages indicating the ICE connection state changes, eventually reaching a "connected" state.

## Dependencies

Ensure you have `ts-node` installed (`npm install -g ts-node` or `yarn global add ts-node`) and have built the project (`npm install && npm run build` in the root directory).
You will also need to install `readline-sync` for this example:
```bash
npm install readline-sync
# or
yarn add readline-sync
```
And the types for it:
```bash
npm install --save-dev @types/readline-sync
# or
yarn add --dev @types/readline-sync
```
