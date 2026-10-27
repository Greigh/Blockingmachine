/**
 * `cert trust-check|install|uninstall` — the OS trust-store verbs. The fetch
 * to `/v1/proxy/ca` is stubbed like the sibling certCommand suite; the core
 * caTrustStore ops are module-mocked (`unstable_mockModule` before the
 * command binds the import, per the ai-crawl-commands convention) so no test
 * ever spawns `security` against a real keychain.
 */

import { jest } from "@jest/globals";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { captureStdout, parseJsonStdout } from "./captureStdout.js";
import type {
  CaInstallOutcome,
  CaRemoveOutcome,
  CaTrustState,
} from "@blockingmachine/core";

/** Injectable stand-ins for the three core trust ops. */
const coreMock = {
  trustStatus: jest.fn<(pem: string) => Promise<CaTrustState>>(),
  installCa: jest.fn<(pem: string) => Promise<CaInstallOutcome>>(),
  removeCa: jest.fn<(pem: string) => Promise<CaRemoveOutcome>>(),
};

jest.unstable_mockModule("@blockingmachine/core", async () => {
  // Spread the real module: the command also consumes the P3 helpers
  // (linuxSystemStoreCommands, firefoxNssProfileDbs) which are pure — only
  // the three OS-touching trust ops are mocked.
  const actual = await jest.requireActual<typeof import("@blockingmachine/core")>(
    "@blockingmachine/core",
  );
  return {
    ...actual,
    trustStatus: (pem: string) => coreMock.trustStatus(pem),
    installCa: (pem: string) => coreMock.installCa(pem),
    removeCa: (pem: string) => coreMock.removeCa(pem),
  };
});

const { CertCommand } = await import("../commands/CertCommand.js");

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

describe("CertCommand trust verbs", () => {
  let tmpDir: string;
  let mockLogger: any;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  const cmd = () =>
    new CertCommand({
      config: { baseDir: tmpDir, sources: [] } as any,
      logger: mockLogger,
    });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-cli-cert-trust-"));
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    fetchMock = jest.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValue(jsonResponse(200, CA_PAYLOAD));
    coreMock.trustStatus.mockReset().mockResolvedValue("absent");
    coreMock.installCa.mockReset().mockResolvedValue("installed");
    coreMock.removeCa.mockReset().mockResolvedValue("removed");
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("trust-check fetches the CA then probes the trust store", async () => {
    coreMock.trustStatus.mockResolvedValue("trusted");
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await cmd().execute({ action: "trust-check" });
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/ca");
      // The PEM from the control API is what the trust probe received.
      expect(coreMock.trustStatus).toHaveBeenCalledWith(CA_PEM);

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("trusted");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("trust-check --json emits trustState beside the CA payload", async () => {
    coreMock.trustStatus.mockResolvedValue("installed-untrusted");
    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "trust-check", json: true });
      expect(result.success).toBe(true);
    });
    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.trustState).toBe("installed-untrusted");
    expect(doc.sha256Fingerprint).toBe("AA:BB:CC:DD:EE:FF");
  });

  test("trust-check honors --port", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmd().execute({ action: "trust-check", port: 19293 });
    } finally {
      logSpy.mockRestore();
    }
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:19293/v1/proxy/ca");
  });

  test("install reports success when the keychain accepts the CA", async () => {
    const result = await cmd().execute({ action: "install" });
    expect(result.success).toBe(true);
    expect(coreMock.installCa).toHaveBeenCalledWith(CA_PEM);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("installed"),
    );
  });

  test("install --json emits the result field", async () => {
    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "install", json: true });
      expect(result.success).toBe(true);
    });
    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.result).toBe("installed");
  });

  test("install needs-admin fails the verb and prints the sudo line", async () => {
    coreMock.installCa.mockResolvedValue("needs-admin");
    const result = await cmd().execute({ action: "install" });
    expect(result.success).toBe(false);
    const warned = mockLogger.warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("\n");
    // The printed path is copy-pasteable: export first, then the sudo form.
    expect(warned).toContain("blockingmachine cert export ca.pem");
    expect(warned).toContain(
      "sudo security add-trusted-cert -d -r trustRoot",
    );
    expect(warned).toContain("login.keychain-db");
    expect(result.message).toContain("administrator");
  });

  test("install needs-admin --json carries the sudo command", async () => {
    coreMock.installCa.mockResolvedValue("needs-admin");
    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "install", json: true });
      expect(result.success).toBe(false);
    });
    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.result).toBe("needs-admin");
    expect(String(doc.sudoCommand)).toContain("sudo security add-trusted-cert");
  });

  test("install needs-admin on linux prints the system-store sudo line", async () => {
    coreMock.installCa.mockResolvedValue("needs-admin");
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await cmd().execute({ action: "install" });
      expect(result.success).toBe(false);
      const warned = mockLogger.warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");
      expect(warned).toContain("blockingmachine cert export ca.pem");
      expect(warned).toContain(
        "sudo cp 'ca.pem' /usr/local/share/ca-certificates/blockingmachine-ca.crt",
      );
      expect(warned).toContain("sudo update-ca-certificates");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });

  test("uninstall needs-admin on linux prints the removal line", async () => {
    coreMock.removeCa.mockResolvedValue("needs-admin");
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await cmd().execute({ action: "uninstall" });
      expect(result.success).toBe(false);
      const warned = mockLogger.warn.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");
      expect(warned).toContain(
        "sudo rm /usr/local/share/ca-certificates/blockingmachine-ca.crt",
      );
      expect(warned).toContain("sudo update-ca-certificates");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });

  test("install unsupported fails honestly", async () => {
    coreMock.installCa.mockResolvedValue("unsupported");
    const result = await cmd().execute({ action: "install" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("unsupported");
  });

  test("uninstall reports removed", async () => {
    const result = await cmd().execute({ action: "uninstall" });
    expect(result.success).toBe(true);
    expect(coreMock.removeCa).toHaveBeenCalledWith(CA_PEM);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("removed"),
    );
  });

  test("uninstall on an absent CA is a clean no-op success", async () => {
    coreMock.removeCa.mockResolvedValue("absent");
    const result = await cmd().execute({ action: "uninstall" });
    expect(result.success).toBe(true);
    expect(result.message).toContain("not present");
  });

  test("uninstall unsupported fails honestly", async () => {
    coreMock.removeCa.mockResolvedValue("unsupported");
    const result = await cmd().execute({ action: "uninstall" });
    expect(result.success).toBe(false);
  });

  test("a dead control API fails before any trust op runs", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await cmd().execute({ action: "install" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("proxy control API");
    expect(coreMock.installCa).not.toHaveBeenCalled();
  });
});
