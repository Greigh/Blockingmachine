import { fetchWithConditionalCache, fetchContent } from "../fetch.js";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

describe("fetchWithConditionalCache", () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-test-fetch-"));
    tempFilePath = path.join(tempDir, "fetch-test.txt");
    await fs.writeFile(
      tempFilePath,
      "||adserver.example.com^\n0.0.0.0 tracking.com",
      "utf8",
    );
  });

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
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

  test("rejects SSRF requests to loopback, private networks, and cloud metadata with 403", async () => {
    const resLoopback = await fetchWithConditionalCache("http://127.0.0.1:8080/admin");
    expect(resLoopback.status).toBe(403);
    expect(resLoopback.content).toBeNull();

    const resMetadata = await fetchWithConditionalCache("http://169.254.169.254/latest/meta-data");
    expect(resMetadata.status).toBe(403);
    expect(resMetadata.content).toBeNull();

    const resPrivate = await fetchWithConditionalCache("http://10.0.0.1/sensitive.txt");
    expect(resPrivate.status).toBe(403);
    expect(resPrivate.content).toBeNull();

    const resLocalhost = await fetchWithConditionalCache("http://localhost:3000/api");
    expect(resLocalhost.status).toBe(403);
    expect(resLocalhost.content).toBeNull();

    const resMappedLoopback = await fetchWithConditionalCache("http://[::ffff:127.0.0.1]:8080/admin");
    expect(resMappedLoopback.status).toBe(403);
    expect(resMappedLoopback.content).toBeNull();

    const resMappedMetadata = await fetchWithConditionalCache("http://[::ffff:169.254.169.254]/latest/meta-data");
    expect(resMappedMetadata.status).toBe(403);
    expect(resMappedMetadata.content).toBeNull();
  });

  test("rejects access to sensitive local system paths with 403", async () => {
    const resPasswd = await fetchWithConditionalCache("/etc/passwd");
    expect(resPasswd.status).toBe(403);
    expect(resPasswd.content).toBeNull();

    const resShadow = await fetchWithConditionalCache("/etc/shadow");
    expect(resShadow.status).toBe(403);
    expect(resShadow.content).toBeNull();

    const resSsh = await fetchWithConditionalCache("~/.ssh/id_rsa");
    expect(resSsh.status).toBe(403);
    expect(resSsh.content).toBeNull();

    const resEnv = await fetchWithConditionalCache("/some/path/.env");
    expect(resEnv.status).toBe(403);
    expect(resEnv.content).toBeNull();
  });

  test("calculates and verifies SHA-256 checksums correctly", async () => {
    // 1. Check valid hash matches
    const firstRes = await fetchWithConditionalCache(tempFilePath);
    expect(firstRes.status).toBe(200);
    expect(firstRes.sha256).toBeDefined();
    expect(typeof firstRes.sha256).toBe("string");
    expect(firstRes.sha256?.length).toBe(64);

    // 2. Fetch with matching expectedSha256
    const matchingRes = await fetchWithConditionalCache(tempFilePath, {
      expectedSha256: firstRes.sha256!,
    });
    expect(matchingRes.status).toBe(200);
    expect(matchingRes.content).toContain("||adserver.example.com^");
    expect(matchingRes.sha256).toBe(firstRes.sha256);

    // 3. Fetch with mismatched expectedSha256
    const badHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // Empty hash
    const mismatchRes = await fetchWithConditionalCache(tempFilePath, {
      expectedSha256: badHash,
    });
    expect(mismatchRes.status).toBe(422);
    expect(mismatchRes.content).toBeNull();
  });
});

