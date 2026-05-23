export class SharedFrontProxyKv {
  private readonly usernameToBackend = new Map<string, string>();
  private readonly clientTransportToBackend = new Map<string, string>();

  setUsernameBackend(username: string, backendId: string) {
    this.usernameToBackend.set(username, backendId);
  }

  getUsernameBackend(username: string) {
    return this.usernameToBackend.get(username);
  }

  setClientTransportBackend(clientTransportKey: string, backendId: string) {
    this.clientTransportToBackend.set(clientTransportKey, backendId);
  }

  getClientTransportBackend(clientTransportKey: string) {
    return this.clientTransportToBackend.get(clientTransportKey);
  }

  deleteClientTransportBackend(clientTransportKey: string) {
    this.clientTransportToBackend.delete(clientTransportKey);
  }

  snapshot() {
    return {
      usernameToBackend: Object.fromEntries(this.usernameToBackend),
      clientTransportToBackend: Object.fromEntries(
        this.clientTransportToBackend,
      ),
    };
  }
}
