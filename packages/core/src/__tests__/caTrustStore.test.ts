/**
 * `caTrustStore` — OS trust-store ops on the HTTPS-filter proxy CA.
 *
 * The unit matrix drives the injected `runner` seam only — no real `security`
 * invocation ever happens here. The `BM_LIVE_TRUST=1` leg at the bottom is the
 * one suite that DOES touch the login keychain, with a freshly minted
 * throwaway CA, and it cleans up in `finally`.
 */

import { describe, expect, it } from "@jest/globals";
import { X509Certificate } from "node:crypto";
import { promises as fs } from "node:fs";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commonNameFromSubject,
  installCa,
  macOsLoginKeychainPath,
  removeCa,
  trustStatus,
  type SecurityRunResult,
  type SecurityRunner,
} from "../caTrustStore.js";

/**
 * A real, tiny self-signed CA PEM (RSA-1024, `CN=Blockingmachine Test CA`) —
 * the same fixture the cli's certCommand tests carry. `trustStatus` parses it
 * for the CN + fingerprint, so a stand-in string would only ever test the
 * parse-failure path.
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

const CA_CN = "Blockingmachine Test CA";
const CA_SHA256 = new X509Certificate(CA_PEM).fingerprint256.replace(/:/g, "");

/** The argv list a fake runner saw, in order. */
function recordingRunner(
  handler: (args: string[], call: number) => SecurityRunResult,
): { runner: SecurityRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: SecurityRunner = async (args) => {
    calls.push([...args]);
    return handler(args, calls.length - 1);
  };
  return { runner, calls };
}

const ok = (stdout = ""): SecurityRunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): SecurityRunResult => ({ code, stdout: "", stderr });

/** A find-certificate -Z dump that contains our cert. */
function findHit(): SecurityRunResult {
  return ok(
    `SHA-256 hash: ${CA_SHA256}\n` +
      `SHA-1 hash: AB7E0960DA09D8E6FA01C26EBEFD811FD5FD4DE7\n` +
      `keychain: "/Users/test/Library/Keychains/login.keychain-db"\n` +
      `    "alis"<blob>="${CA_CN}"\n`,
  );
}

describe("commonNameFromSubject", () => {
  it("parses a single-RDN subject", () => {
    expect(commonNameFromSubject("CN=Blockingmachine Test CA")).toBe("Blockingmachine Test CA");
  });

  it("parses a multi-RDN newline subject (Node's rendering)", () => {
    expect(
      commonNameFromSubject("C=US\nO=Internet Security Research Group\nCN=ISRG Root X1"),
    ).toBe("ISRG Root X1");
  });

  it("parses a comma-separated subject and unescapes \\,", () => {
    expect(commonNameFromSubject("C=US,CN=Acme\\, Inc,O=Corp")).toBe("Acme, Inc");
  });

  it("returns null when no CN RDN exists", () => {
    expect(commonNameFromSubject("C=US\nO=No Name Here")).toBeNull();
  });
});

describe("macOsLoginKeychainPath", () => {
  it("uses HOME before os.homedir()", () => {
    expect(macOsLoginKeychainPath("/home/tester")).toBe(
      path.join("/home/tester", "Library", "Keychains", "login.keychain-db"),
    );
  });
});

describe("trustStatus", () => {
  it("returns 'unsupported' off darwin without spawning anything", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(trustStatus(CA_PEM, { runner, platform: "linux" })).resolves.toBe("unsupported");
    await expect(trustStatus(CA_PEM, { runner, platform: "win32" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("returns 'absent' when find-certificate matches nothing", async () => {
    const { runner, calls } = recordingRunner(() => ok(""));
    await expect(trustStatus(CA_PEM, { runner })).resolves.toBe("absent");
    // find-certificate exits 0 even on a miss — empty stdout IS the absent
    // signal, and the argv must ask for -Z hashes and the parsed CN.
    expect(calls).toEqual([["find-certificate", "-Z", "-a", "-c", CA_CN]]);
  });

  it("returns 'absent' when a same-name cert has a different fingerprint", async () => {
    const { runner } = recordingRunner(() =>
      ok("SHA-256 hash: DEADBEEF\nkeychain: \"login.keychain-db\"\n"),
    );
    await expect(trustStatus(CA_PEM, { runner })).resolves.toBe("absent");
  });

  it("returns 'trusted' when the cert is present and verify-cert exits 0", async () => {
    const { runner, calls } = recordingRunner((args) =>
      args[0] === "find-certificate" ? findHit() : ok("...certificate verification successful."),
    );
    await expect(trustStatus(CA_PEM, { runner })).resolves.toBe("trusted");
    expect(calls[0]).toEqual(["find-certificate", "-Z", "-a", "-c", CA_CN]);
    // verify-cert runs the BASIC policy against the tmp PEM — `-p ssl` would
    // fail every CA (no serverAuth EKU), verified live against ISRG Root X1.
    expect(calls[1][0]).toBe("verify-cert");
    expect(calls[1][1]).toBe("-c");
    expect(calls[1][2]).toMatch(/bm-ca-.*\.pem$/);
  });

  it("returns 'installed-untrusted' when the cert is present but verify fails", async () => {
    const { runner } = recordingRunner((args) =>
      args[0] === "find-certificate" ? findHit() : fail("Cert Verify Result: CSSMERR_TP_NOT_TRUSTED"),
    );
    await expect(trustStatus(CA_PEM, { runner })).resolves.toBe("installed-untrusted");
  });

  it("throws when find-certificate exits nonzero — a failed lookup is not 'absent'", async () => {
    const { runner } = recordingRunner(() => fail("keychain is corrupt"));
    await expect(trustStatus(CA_PEM, { runner })).rejects.toThrow("find-certificate");
  });

  it("propagates runner rejections rather than mapping them to a state", async () => {
    const runner: SecurityRunner = async () => {
      throw new Error("spawn security ENOENT");
    };
    await expect(trustStatus(CA_PEM, { runner })).rejects.toThrow("ENOENT");
  });

  it("throws on a PEM the platform parser rejects", async () => {
    await expect(trustStatus("not a pem", { runner: async () => ok() })).rejects.toThrow();
  });
});

describe("installCa", () => {
  it("returns 'unsupported' off darwin", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(installCa(CA_PEM, { runner, platform: "linux" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("runs add-trusted-cert -d -r trustRoot against the login keychain", async () => {
    const { runner, calls } = recordingRunner((args) => {
      if (args[0] === "find-certificate") return findHit();
      return ok();
    });
    await expect(
      installCa(CA_PEM, { runner, homeDir: "/Users/tester" }),
    ).resolves.toBe("installed");
    expect(calls[0]).toEqual([
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      path.join("/Users/tester", "Library", "Keychains", "login.keychain-db"),
      calls[0][6],
    ]);
    expect(calls[0][6]).toMatch(/bm-ca-.*\.pem$/);
    // Honest post-verify: a successful add is followed by a trustStatus probe.
    expect(calls[1][0]).toBe("find-certificate");
  });

  it("maps an authorization denial to 'needs-admin'", async () => {
    const { runner } = recordingRunner(() =>
      fail("SecTrustSettingsSetTrustSettings: The authorization was denied."),
    );
    await expect(installCa(CA_PEM, { runner })).resolves.toBe("needs-admin");
  });

  it("maps 'User interaction is not allowed' to 'needs-admin'", async () => {
    const { runner } = recordingRunner(() =>
      fail("security: SecKeychainItemCreateFromContent: User interaction is not allowed."),
    );
    await expect(installCa(CA_PEM, { runner })).resolves.toBe("needs-admin");
  });

  it("throws on a failure that is not an authorization denial", async () => {
    const { runner } = recordingRunner(() => fail("some bizarre keychain error"));
    await expect(installCa(CA_PEM, { runner })).rejects.toThrow("bizarre keychain error");
  });

  it("throws when a reported-successful add leaves the keychain empty", async () => {
    // add says ok, but the post-verify finds nothing — a claim we refuse to make.
    const { runner } = recordingRunner((args) => {
      if (args[0] === "add-trusted-cert") return ok();
      return ok(""); // find-certificate: empty
    });
    await expect(installCa(CA_PEM, { runner })).rejects.toThrow("not in the keychain");
  });
});

describe("removeCa", () => {
  it("returns 'unsupported' off darwin", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(removeCa(CA_PEM, { runner, platform: "linux" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("returns 'absent' when the cert is not in the keychain, deleting nothing", async () => {
    const { runner, calls } = recordingRunner(() => ok(""));
    await expect(removeCa(CA_PEM, { runner })).resolves.toBe("absent");
    expect(calls).toEqual([["find-certificate", "-Z", "-a", "-c", CA_CN]]);
  });

  it("removes admin trust settings then the cert, then re-probes", async () => {
    // Sequence: find(hit) → remove-trusted-cert → delete-certificate → find(miss)
    const { runner, calls } = recordingRunner((args, i) => {
      if (args[0] === "find-certificate") return i === 0 ? findHit() : ok("");
      return ok();
    });
    await expect(removeCa(CA_PEM, { runner })).resolves.toBe("removed");
    expect(calls[1][0]).toBe("remove-trusted-cert");
    expect(calls[1][1]).toBe("-d");
    expect(calls[2]).toEqual(["delete-certificate", "-t", "-Z", CA_SHA256]);
    expect(calls[3][0]).toBe("find-certificate");
  });

  it("throws when the cert survives delete-certificate", async () => {
    const { runner } = recordingRunner(() => findHit()); // find keeps hitting
    await expect(removeCa(CA_PEM, { runner })).rejects.toThrow("still in the keychain");
  });
});

describe("tmp PEM hygiene", () => {
  it("writes the tmp PEM 0600 inside tmpDir and unlinks it after", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-trust-test-"));
    let seenMode: number | null = null;
    const { runner } = recordingRunner((args) => {
      if (args[0] === "verify-cert") {
        // The runner sees the tmp path mid-call — stat it before cleanup.
        seenMode = statSync(args[2]).mode & 0o777;
        return ok();
      }
      return findHit();
    });
    await expect(trustStatus(CA_PEM, { runner, tmpDir })).resolves.toBe("trusted");
    expect(seenMode).toBe(0o600);
    const leftovers = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".pem"));
    expect(leftovers).toEqual([]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("unlinks the tmp PEM even when the runner throws", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-trust-test-"));
    const runner: SecurityRunner = async (args) => {
      if (args[0] === "verify-cert") throw new Error("boom");
      return findHit();
    };
    await expect(trustStatus(CA_PEM, { runner, tmpDir })).rejects.toThrow("boom");
    const leftovers = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".pem"));
    expect(leftovers).toEqual([]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

/**
 * The one leg that touches a real keychain — `BM_LIVE_TRUST=1` opt-in, darwin
 * only, throwaway CA minted per run and removed in `finally`.
 *
 * What it can assert depends on the session: in a GUI console the
 * `add-trusted-cert` auth prompt can complete and the full install → trusted →
 * remove → absent round-trip runs; in a headless/locked context the install
 * answers `needs-admin` (verified: `SecTrustSettingsSetTrustSettings: The
 * authorization was denied.`) — but the denied add still files the cert into
 * the keychain untrusted, so the installed-untrusted → remove → absent legs
 * still exercise the real tools end to end.
 */
const LIVE = process.env.BM_LIVE_TRUST === "1" && process.platform === "darwin";
const liveIt = LIVE ? it : it.skip;

describe("darwin live keychain round-trip (BM_LIVE_TRUST=1)", () => {
  liveIt("installs, reads trust state, and removes a throwaway CA", async () => {
    const forge = (await import("node-forge")).default;
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 24 * 3600 * 1000);
    const attrs = [{ name: "commonName", value: `BM Live Trust Probe ${process.pid}` }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([{ name: "basicConstraints", cA: true }]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pem = forge.pki.certificateToPem(cert);

    try {
      await expect(trustStatus(pem)).resolves.toBe("absent");

      const installed = await installCa(pem);
      if (installed === "needs-admin") {
        // Headless/locked session — the consent prompt cannot be serviced here.
        // The denied add still filed the cert untrusted (verified behavior), so
        // the rest of the round-trip still runs against the real keychain.
        console.warn(
          "[live-trust] add-trusted-cert could not obtain authorization in this " +
            "session — exercising the installed-untrusted legs instead of trusted.",
        );
        await expect(trustStatus(pem)).resolves.toBe("installed-untrusted");
      } else {
        expect(installed).toBe("installed");
        await expect(trustStatus(pem)).resolves.toBe("trusted");
      }

      await expect(removeCa(pem)).resolves.toBe("removed");
      await expect(trustStatus(pem)).resolves.toBe("absent");
    } finally {
      // Belt and braces: a failed mid-test must not strand the probe cert.
      await removeCa(pem).catch(() => {});
    }
  });
});
