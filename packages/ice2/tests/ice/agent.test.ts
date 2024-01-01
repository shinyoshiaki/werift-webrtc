import { IceAgent } from "../../src/ice/agent";

describe("ice/agent", () => {
  describe("gatheringCandidates", () => {
    it("should return candidates", async () => {
      const agent = new IceAgent();
      const candidates = await agent.gatherCandidates();
      console.log(candidates);
      expect(candidates.length).toBeGreaterThan(1);
      for (const candidate of candidates) {
        expect(candidate.address[0]).toMatch(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
        expect(candidate.address[1]).toBeGreaterThan(0);
      }
    });

    it("should return a candidate with isLite", async () => {
      const agent = new IceAgent({ isLite: true });
      const candidates = await agent.gatherCandidates();
      console.log(candidates);
      expect(candidates.length).toBe(1);
      const candidate = candidates[0];
      expect(candidate.address[0]).toMatch(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
      expect(candidate.address[1]).toBeGreaterThan(0);
    });
  });
});
