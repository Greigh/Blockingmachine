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

  test("fetches local file with file:// protocol scheme", async () => {
    const fileUrl = `file://${tempFilePath}`;
    const res = await fetchWithConditionalCache(fileUrl);
    expect(res.status).toBe(200);
    expect(res.content).toContain("||adserver.example.com^");
  });

  test("returns 404 when target local path is a directory", async () => {
    const res = await fetchWithConditionalCache(os.tmpdir());
    expect(res.status).toBe(404);
    expect(res.content).toBeNull();
  });

  test("returns 500 when local file does not exist", async () => {
    const nonExistentPath = path.join(os.tmpdir(), "non-existent-filter-file.txt");
    const res = await fetchWithConditionalCache(nonExistentPath);
    expect(res.status).toBe(500);
    expect(res.content).toBeNull();
  });

  test("fetchContent returns null for non-existent file", async () => {
    const nonExistentPath = path.join(os.tmpdir(), "non-existent-filter-file-2.txt");
    const content = await fetchContent(nonExistentPath);
    expect(content).toBeNull();
  });

  test("returns 400 when URL is malformed and invalid", async () => {
    const res = await fetchWithConditionalCache("http://[invalid-ipv6-bracket");
    expect(res.status).toBe(400);
    expect(res.content).toBeNull();
  });

  test("rejects URLs containing null-byte character with 400", async () => {
    const res = await fetchWithConditionalCache(tempFilePath + "\0.malicious");
    expect(res.status).toBe(400);
    expect(res.content).toBeNull();
  });

  test("rejects URLs containing newline or carriage return characters with 400", async () => {
    const resNewline = await fetchWithConditionalCache("https://example.com/filter\n.txt");
    expect(resNewline.status).toBe(400);
    expect(resNewline.content).toBeNull();

    const resCR = await fetchWithConditionalCache("https://example.com/filter\r.txt");
    expect(resCR.status).toBe(400);
    expect(resCR.content).toBeNull();
  });
});
