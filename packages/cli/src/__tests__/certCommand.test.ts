import { jest } from "@jest/globals";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { CertCommand } from "../commands/CertCommand.js";
import { captureStdout, parseJsonStdout } from "./captureStdout.js";

/**
 * A real, tiny self-signed CA PEM (RSA-1024, generated once with the repo's
 * vendored node-forge, valid 2026-01-01 → 2036-01-01). `cert status` parses
 * it for the `Valid from` line, so a stand-in string would only ever test
 * the fallback path.
 */
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIByjCCATOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAiMSAwHgYDVQQDExdCbG9j
a2luZ21hY2hpbmUgVGVzdCBDQTAeFw0yNjAxMDEwMDAwMDBaFw0zNjAxMDEwMDAw
MDBaMCIxIDAeBgNVBAMTF0Jsb2NraW5nbWFjaGluZSBUZXN0IENBMIGfMA0GCSqG
SIb3DQEBAQUAA4GNADCBiQKBgQC4RdTH06+jCjV9LKKg+Sk37EqNOPJHLkMUgd6i
JSO9xWSRqM8FO+VVHJJvp7MQ224Tn+pAw/S4fDhuz2BDfOXLvoF4p0I9ipKMaxVq
BPqEMFoaio4KcCg1TDnOTwd1eUVr40QYfRWmYDC2ZxtGKAnKn+2e545hLlEuHaX7
bRpHzQIDAQABoxAwDjAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA4GBAHL4
bR9RjyMobVW4PAs7hGfxknEKB0A91KGMrsDkaAPHN8Q8hv7i1P5M1ARu6ZsjaMux
3hSplnIC9AcjbHVn13k6FbN7UGENXZ8rr5DmpevueNjKzmsTX5UBtC98ceSu01zq
Xv8VJUPmEK1MpMgGe/moneBHz4JhmcBSHq6V2syJ
-----END CERTIFICATE-----
`;

const CA_PAYLOAD = {
  certPem: CA_PEM,
  sha256Fingerprint: "AA:BB:CC:DD:EE:FF",
  notAfter: "Jan  1 00:00:00 2036 GMT",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CertCommand", () => {
  let tmpDir: string;
  let mockLogger: any;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  const cmd = () =>
    new CertCommand({
      config: { baseDir: tmpDir, sources: [] } as any,
      logger: mockLogger,
    });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-cli-cert-"));
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    fetchMock = jest.spyOn(globalThis, "fetch");
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("status GETs /v1/proxy/ca and prints the fingerprint + validity window", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));
    // The human report leaves through `console.log` like every command
    // report here; jest's injected console bypasses `process.stdout.write`,
    // so it is spied rather than captured.
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await cmd().execute({ action: "status" });
      expect(result.success).toBe(true);

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/ca");
      expect(init?.method ?? "GET").toBe("GET");

      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("AA:BB:CC:DD:EE:FF");
      expect(printed).toContain("Valid until");
      expect(printed).toContain("Jan  1 00:00:00 2036 GMT");
      // `validFrom` is read out of the PEM itself — the route does not carry it.
      expect(printed).toContain("Valid from");
      expect(printed).toContain("2026");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("status --json prints the full payload, PEM included", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "status", json: true });
      expect(result.success).toBe(true);
    });

    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.sha256Fingerprint).toBe("AA:BB:CC:DD:EE:FF");
    expect(String(doc.certPem)).toContain("BEGIN CERTIFICATE");
  });

  test("export <path> writes the PEM verbatim", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));
    const target = path.join(tmpDir, "nested", "ca.pem");

    const result = await cmd().execute({ action: "export", path: target });
    expect(result.success).toBe(true);
    expect(result.data.path).toBe(target);

    const written = await fs.readFile(target, "utf8");
    expect(written).toBe(CA_PEM.endsWith("\n") ? CA_PEM : `${CA_PEM}\n`);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("CA certificate written"),
    );
  });

  test("export with no path writes the PEM to stdout", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "export" });
      expect(result.success).toBe(true);
    });

    expect(stdout).toContain("-----BEGIN CERTIFICATE-----");
    expect(stdout).toContain("-----END CERTIFICATE-----");
  });

  test("export honors a --port override", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "export", port: 19293 });
      expect(result.success).toBe(true);
    });
    expect(stdout).toContain("BEGIN CERTIFICATE");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:19293/v1/proxy/ca");
  });

  test("a 500 envelope fails with the server's error text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { success: false, error: "CA keystore unreadable" }),
    );

    const result = await cmd().execute({ action: "status" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("CA keystore unreadable");
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test("a non-JSON response fails rather than writing garbage as a PEM", async () => {
    fetchMock.mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await cmd().execute({
      action: "export",
      path: path.join(tmpDir, "ca.pem"),
    });
    expect(result.success).toBe(false);
    await expect(fs.stat(path.join(tmpDir, "ca.pem"))).rejects.toThrow();
  });

  test("an unknown action fails before any request goes out", async () => {
    const result = await cmd().execute({ action: "rotate" as any });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown cert action");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
