import { fetchWithConditionalCache, fetchContent } from "../fetch.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

describe("fetchWithConditionalCache", () => {
  let tempFilePath: string;

  beforeAll(async () => {
    tempFilePath = path.join(os.tmpdir(), `bm-test-fetch-${Date.now()}.txt`);
    await fs.writeFile(
      tempFilePath,
      "||adserver.example.com^\n0.0.0.0 tracking.com",
      "utf8",
    );
  });

  afterAll(async () => {
    try {
      await fs.unlink(tempFilePath);
    } catch {
      // ignore
    }
  });

  test("fetches local file content with status 200 and lastModified", async () => {
    const res = await fetchWithConditionalCache(tempFilePath);
    expect(res.status).toBe(200);
    expect(res.notModified).toBe(false);
    expect(res.content).toContain("||adserver.example.com^");
    expect(res.lastModified).toBeDefined();
  });

  test("returns notModified: true with 304 when lastModified matches or is future", async () => {
    const firstRes = await fetchWithConditionalCache(tempFilePath);
    expect(firstRes.lastModified).toBeDefined();

    const secondRes = await fetchWithConditionalCache(tempFilePath, {
      lastModified: firstRes.lastModified || undefined,
    });
    expect(secondRes.status).toBe(304);
    expect(secondRes.notModified).toBe(true);
    expect(secondRes.content).toBeNull();
  });

  test("fetchContent returns string for valid file", async () => {
    const content = await fetchContent(tempFilePath);
    expect(content).toContain("0.0.0.0 tracking.com");
  });
});
