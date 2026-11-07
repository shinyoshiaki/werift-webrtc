import { startLocalStun } from "./helpers/stunFixture.js";

export default async function setup() {
  const stun = await startLocalStun();
  return () => stun.close();
}
