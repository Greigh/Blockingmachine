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
  firefoxNssProfileDbs,
  installCa,
  linuxSystemStoreCommands,
  macOsLoginKeychainPath,
  removeCa,
  trustStatus,
  type PlatformRunner,
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
// Windows "thumbprint" = the sha1 fingerprint, bare hex — certutil's cert id.
const CA_SHA1 = new X509Certificate(CA_PEM).fingerprint.replace(/:/g, "");
/** Pin every darwin test's platform — CI runs on ubuntu, where an unpinned
 * call would now take the real linux branch instead of the fake-runner path. */
const DARWIN = { platform: "darwin" as NodeJS.Platform };
const WIN32 = { platform: "win32" as NodeJS.Platform };
const LINUX = { platform: "linux" as NodeJS.Platform };

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
  it("returns 'unsupported' on an unimplemented platform without spawning anything", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(trustStatus(CA_PEM, { runner, platform: "freebsd" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("returns 'absent' when find-certificate matches nothing", async () => {
    const { runner, calls } = recordingRunner(() => ok(""));
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).resolves.toBe("absent");
    // find-certificate exits 0 even on a miss — empty stdout IS the absent
    // signal, and the argv must ask for -Z hashes and the parsed CN.
    expect(calls).toEqual([["find-certificate", "-Z", "-a", "-c", CA_CN]]);
  });

  it("returns 'absent' when a same-name cert has a different fingerprint", async () => {
    const { runner } = recordingRunner(() =>
      ok("SHA-256 hash: DEADBEEF\nkeychain: \"login.keychain-db\"\n"),
    );
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).resolves.toBe("absent");
  });

  it("returns 'trusted' when the cert is present and verify-cert exits 0", async () => {
    const { runner, calls } = recordingRunner((args) =>
      args[0] === "find-certificate" ? findHit() : ok("...certificate verification successful."),
    );
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).resolves.toBe("trusted");
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
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).resolves.toBe("installed-untrusted");
  });

  it("throws when find-certificate exits nonzero — a failed lookup is not 'absent'", async () => {
    const { runner } = recordingRunner(() => fail("keychain is corrupt"));
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).rejects.toThrow("find-certificate");
  });

  it("propagates runner rejections rather than mapping them to a state", async () => {
    const runner: SecurityRunner = async () => {
      throw new Error("spawn security ENOENT");
    };
    await expect(trustStatus(CA_PEM, { runner, ...DARWIN })).rejects.toThrow("ENOENT");
  });

  it("throws on a PEM the platform parser rejects", async () => {
    await expect(
      trustStatus("not a pem", { runner: async () => ok(), ...DARWIN }),
    ).rejects.toThrow();
  });
});

describe("installCa", () => {
  it("returns 'unsupported' on an unimplemented platform", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(installCa(CA_PEM, { runner, platform: "freebsd" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("runs add-trusted-cert -d -r trustRoot against the login keychain", async () => {
    const { runner, calls } = recordingRunner((args) => {
      if (args[0] === "find-certificate") return findHit();
      return ok();
    });
    await expect(
      installCa(CA_PEM, { runner, homeDir: "/Users/tester", ...DARWIN }),
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
    await expect(installCa(CA_PEM, { runner, ...DARWIN })).resolves.toBe("needs-admin");
  });

  it("maps 'User interaction is not allowed' to 'needs-admin'", async () => {
    const { runner } = recordingRunner(() =>
      fail("security: SecKeychainItemCreateFromContent: User interaction is not allowed."),
    );
    await expect(installCa(CA_PEM, { runner, ...DARWIN })).resolves.toBe("needs-admin");
  });

  it("throws on a failure that is not an authorization denial", async () => {
    const { runner } = recordingRunner(() => fail("some bizarre keychain error"));
    await expect(installCa(CA_PEM, { runner, ...DARWIN })).rejects.toThrow("bizarre keychain error");
  });

  it("throws when a reported-successful add leaves the keychain empty", async () => {
    // add says ok, but the post-verify finds nothing — a claim we refuse to make.
    const { runner } = recordingRunner((args) => {
      if (args[0] === "add-trusted-cert") return ok();
      return ok(""); // find-certificate: empty
    });
    await expect(installCa(CA_PEM, { runner, ...DARWIN })).rejects.toThrow("not in the keychain");
  });
});

describe("removeCa", () => {
  it("returns 'unsupported' on an unimplemented platform", async () => {
    const { runner, calls } = recordingRunner(() => ok());
    await expect(removeCa(CA_PEM, { runner, platform: "freebsd" })).resolves.toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("returns 'absent' when the cert is not in the keychain, deleting nothing", async () => {
    const { runner, calls } = recordingRunner(() => ok(""));
    await expect(removeCa(CA_PEM, { runner, ...DARWIN })).resolves.toBe("absent");
    expect(calls).toEqual([["find-certificate", "-Z", "-a", "-c", CA_CN]]);
  });

  it("removes admin trust settings then the cert, then re-probes", async () => {
    // Sequence: find(hit) → remove-trusted-cert → delete-certificate → find(miss)
    const { runner, calls } = recordingRunner((args, i) => {
      if (args[0] === "find-certificate") return i === 0 ? findHit() : ok("");
      return ok();
    });
    await expect(removeCa(CA_PEM, { runner, ...DARWIN })).resolves.toBe("removed");
    expect(calls[1][0]).toBe("remove-trusted-cert");
    expect(calls[1][1]).toBe("-d");
    expect(calls[2]).toEqual(["delete-certificate", "-t", "-Z", CA_SHA256]);
    expect(calls[3][0]).toBe("find-certificate");
  });

  it("throws when the cert survives delete-certificate", async () => {
    const { runner } = recordingRunner(() => findHit()); // find keeps hitting
    await expect(removeCa(CA_PEM, { runner, ...DARWIN })).rejects.toThrow("still in the keychain");
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
    await expect(trustStatus(CA_PEM, { runner, tmpDir, ...DARWIN })).resolves.toBe("trusted");
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
    await expect(trustStatus(CA_PEM, { runner, tmpDir, ...DARWIN })).rejects.toThrow("boom");
    const leftovers = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".pem"));
    expect(leftovers).toEqual([]);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ============================================================================
// win32 — `certutil -user` against the CurrentUser Root store (P3 Task 3)
// ============================================================================
// Same discipline as the darwin matrix: the injected `platformRunner` sees
// `(file, args)` — 'certutil' here — and nothing ever spawns for real.

/** A recording runner shaped like the P3 seam: (file, args). */
function recordingPlatformRunner(
  handler: (file: string, args: string[], call: number) => SecurityRunResult | Promise<SecurityRunResult>,
): { runner: PlatformRunner; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: PlatformRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    return handler(file, args, calls.length - 1);
  };
  return { runner, calls };
}

/** certutil's `-verifystore` hit output — a cert dump carrying its Cert Hash(sha1). */
function winVerifyHit(): SecurityRunResult {
  return ok(
    'Root "Trusted Root Certification Authorities"\n' +
      "================ Certificate 0 ================\n" +
      `Subject: CN=${CA_CN}\n` +
      `Cert Hash(sha1): ${CA_SHA1.match(/.{2}/g)!.join(" ")}\n` +
      "CertUtil: -verifystore command completed successfully.\n",
  );
}

/** certutil's miss: nonzero exit + CRYPT_E_NOT_FOUND on stderr. */
function winVerifyMiss(): SecurityRunResult {
  return fail(
    "CertUtil: -verifystore command FAILED: 0x80092004 (-2146885628 CRYPT_E_NOT_FOUND)\n" +
      "CertUtil: Cannot find object or property.",
  );
}

describe("win32 certutil trust ops", () => {
  it("trustStatus reads 'trusted' when -verifystore Root prints our sha1 hash", async () => {
    const { runner, calls } = recordingPlatformRunner(() => winVerifyHit());
    await expect(trustStatus(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("trusted");
    expect(calls).toEqual([
      { file: "certutil", args: ["-user", "-verifystore", "Root", CA_SHA1] },
    ]);
  });

  it("trustStatus reads 'absent' on CRYPT_E_NOT_FOUND", async () => {
    const { runner } = recordingPlatformRunner(() => winVerifyMiss());
    await expect(trustStatus(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("absent");
  });

  it("trustStatus reads 'absent' when the printed hash is not ours (impostor)", async () => {
    const { runner } = recordingPlatformRunner(() =>
      ok('Subject: CN=Someone Else\nCert Hash(sha1): aa bb cc dd ee ff\n'),
    );
    await expect(trustStatus(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("absent");
  });

  it("trustStatus throws on a failure that is not a not-found", async () => {
    const { runner } = recordingPlatformRunner(() => fail("certutil exploded"));
    await expect(
      trustStatus(CA_PEM, { platformRunner: runner, ...WIN32 }),
    ).rejects.toThrow("certutil -verifystore failed");
  });

  it("the legacy `runner` seam cannot fake win32 tools — it rejects for certutil", async () => {
    const { runner } = recordingRunner(() => ok());
    await expect(trustStatus(CA_PEM, { runner, ...WIN32 })).rejects.toThrow("platformRunner");
  });

  it("installCa runs -user -addstore Root then post-verifies by fingerprint", async () => {
    // argv is ['-user', <verb>, …] — the verb is args[1].
    const { runner, calls } = recordingPlatformRunner((file, args) =>
      args[1] === "-addstore" ? ok("CertUtil: -addstore command completed successfully.") : winVerifyHit(),
    );
    await expect(installCa(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("installed");
    expect(calls[0]).toEqual({
      file: "certutil",
      args: ["-user", "-addstore", "Root", calls[0].args[3]],
    });
    expect(calls[0].args[3]).toMatch(/bm-ca-.*\.pem$/);
    expect(calls[1].args).toEqual(["-user", "-verifystore", "Root", CA_SHA1]);
  });

  it("installCa maps an access-denied to 'needs-admin' (machine store is the escalation)", async () => {
    const { runner } = recordingPlatformRunner(() =>
      fail("CertUtil: -addstore command FAILED: 0x80070005\nCertUtil: Access is denied."),
    );
    await expect(installCa(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("needs-admin");
  });

  it("installCa throws when a reported-successful add leaves the store empty", async () => {
    const { runner } = recordingPlatformRunner((file, args) =>
      args[1] === "-addstore" ? ok() : winVerifyMiss(),
    );
    await expect(installCa(CA_PEM, { platformRunner: runner, ...WIN32 })).rejects.toThrow(
      "not in the user Root store",
    );
  });

  it("removeCa delstore's the sha1 thumbprint then verifies by re-probe", async () => {
    // The fake flips to "miss" once -delstore has run — the post-state check.
    let deleted = false;
    const { runner, calls } = recordingPlatformRunner((file, args) => {
      if (args[1] === "-delstore") {
        deleted = true;
        return ok("CertUtil: -delstore command completed successfully.");
      }
      return deleted ? winVerifyMiss() : winVerifyHit();
    });
    await expect(removeCa(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("removed");
    expect(calls[1].args).toEqual(["-user", "-delstore", "Root", CA_SHA1]);
    expect(calls[2].args[1]).toBe("-verifystore");
  });

  it("removeCa answers 'absent' without deleting when the cert is not in Root", async () => {
    const { runner, calls } = recordingPlatformRunner(() => winVerifyMiss());
    await expect(removeCa(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("absent");
    expect(calls).toHaveLength(1);
  });

  it("removeCa answers 'needs-admin' when the delete is denied and the cert stays", async () => {
    const { runner } = recordingPlatformRunner((file, args) =>
      args[1] === "-delstore"
        ? fail("CertUtil: -delstore command FAILED: 0x80070005\nCertUtil: Access is denied.")
        : winVerifyHit(),
    );
    await expect(removeCa(CA_PEM, { platformRunner: runner, ...WIN32 })).resolves.toBe("needs-admin");
  });
});

// ============================================================================
// linux — NSS certutil on ~/.pki/nssdb + the distro system store (P3 Task 3)
// ============================================================================
// The runner fakes cover the certutil argv; the system-store side is real
// fs against injected dirs (`linuxSystemStore`/`homeDir` seams).

/** certutil's "the db does not exist" failure. */
function nssDbMissing(): SecurityRunResult {
  return fail("certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.");
}

/** A `certutil -L` listing row for our CN with the given trust flags. */
function nssList(flags: string): SecurityRunResult {
  return ok(
    "Certificate Nickname                                         Trust Attributes\n" +
      "                                                             SSL,S/MIME,JAR/XPI\n\n" +
      `${CA_CN.padEnd(60)}${flags}\n`,
  );
}

/** Runner where every certutil spawn fails ENOENT — the "no NSS tooling" box. */
const noCertutilRunner: PlatformRunner = async (file) => {
  throw new Error(`${file} could not run: spawn ${file} ENOENT`);
};

describe("linux NSS certutil trust ops", () => {
  const noSystemStore = {
    linuxSystemStore: { sourceDirs: ["/nonexistent/src"], bundleFiles: ["/nonexistent/bundle.crt"] },
  };

  it("trustStatus reads 'trusted' when the nssdb row flags our fingerprint 'T'", async () => {
    const { runner, calls } = recordingPlatformRunner((file, args) => {
      if (args[0] === "-L" && args.includes("-a")) return ok(CA_PEM);
      if (args[0] === "-L") return nssList("CT,,");
      return fail("unexpected");
    });
    await expect(
      trustStatus(CA_PEM, { platformRunner: runner, homeDir: "/home/t", ...LINUX, ...noSystemStore }),
    ).resolves.toBe("trusted");
    expect(calls[0]).toEqual({
      file: "certutil",
      args: ["-L", "-d", "sql:/home/t/.pki/nssdb"],
    });
    // The fingerprint dump is what proves identity — not the nickname.
    expect(calls[1].args).toEqual(["-L", "-n", CA_CN, "-a", "-d", "sql:/home/t/.pki/nssdb"]);
  });

  it("trustStatus reads 'installed-untrusted' when the row lacks the SSL T flag", async () => {
    const { runner } = recordingPlatformRunner((file, args) => {
      if (args.includes("-a")) return ok(CA_PEM);
      return nssList("P,,");
    });
    await expect(
      trustStatus(CA_PEM, { platformRunner: runner, homeDir: "/home/t", ...LINUX, ...noSystemStore }),
    ).resolves.toBe("installed-untrusted");
  });

  it("trustStatus reads 'absent' when the listed nickname dumps a different cert", async () => {
    const other = `-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n`;
    const { runner } = recordingPlatformRunner((file, args) => {
      if (args.includes("-a")) return ok(other);
      return nssList("CT,,");
    });
    // The dump won't even parse — definitely not our fingerprint → absent.
    await expect(
      trustStatus(CA_PEM, { platformRunner: runner, homeDir: "/home/t", ...LINUX, ...noSystemStore }),
    ).resolves.toBe("absent");
  });

  it("trustStatus reads 'absent' when the db is missing and the system store is empty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-empty-"));
    const { runner } = recordingPlatformRunner(() => nssDbMissing());
    await expect(
      trustStatus(CA_PEM, {
        platformRunner: runner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: [dir], bundleFiles: [path.join(dir, "no-bundle.crt")] },
      }),
    ).resolves.toBe("absent");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("trustStatus finds the CA in the live system bundle → 'trusted'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-sys-"));
    const bundle = path.join(dir, "ca-certificates.crt");
    await fs.writeFile(bundle, `other-garbage\n${CA_PEM}\n`);
    const { runner, calls } = recordingPlatformRunner(() => nssDbMissing());
    await expect(
      trustStatus(CA_PEM, {
        platformRunner: runner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: [path.join(dir, "no-src")], bundleFiles: [bundle] },
      }),
    ).resolves.toBe("trusted");
    expect(calls).toHaveLength(1); // no per-cert dumps needed — fs did it
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("trustStatus finds a source-dir .crt that is not yet in a bundle → 'installed-untrusted'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-src-"));
    const src = path.join(dir, "ca-certificates");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "blockingmachine-ca.crt"), CA_PEM);
    const { runner } = recordingPlatformRunner(() => nssDbMissing());
    await expect(
      trustStatus(CA_PEM, {
        platformRunner: runner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: [src], bundleFiles: [path.join(dir, "no-bundle.crt")] },
      }),
    ).resolves.toBe("installed-untrusted");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("trustStatus answers 'unsupported' when certutil AND the system store are both absent", async () => {
    await expect(
      trustStatus(CA_PEM, {
        platformRunner: noCertutilRunner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: ["/nonexistent"], bundleFiles: ["/nonexistent/x.crt"] },
      }),
    ).resolves.toBe("unsupported");
  });

  it("installCa creates the db via -N then adds with CT,C,C and post-verifies", async () => {
    // homeDir is a real tmp dir — the no-db path really does fs.mkdir on
    // ~/.pki/nssdb, so the test home must be somewhere disposable.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-home-"));
    const spec = `sql:${path.join(home, ".pki", "nssdb")}`;
    let dbCreated = false;
    const { runner, calls } = recordingPlatformRunner((file, args) => {
      if (args[0] === "-N") {
        dbCreated = true;
        return ok("");
      }
      if (args[0] === "-A") return ok("");
      if (args.includes("-a")) return ok(CA_PEM);
      // -L: missing until created, then lists our nick with trust flags.
      return dbCreated ? nssList("CT,C,C") : nssDbMissing();
    });
    try {
      await expect(
        installCa(CA_PEM, { platformRunner: runner, homeDir: home, ...LINUX, ...noSystemStore }),
      ).resolves.toBe("installed");
      expect(calls[0].args[0]).toBe("-L");
      expect(calls[1].args[0]).toBe("-N");
      expect(calls[1].args).toContain("--empty-password");
      expect(calls[2].args[0]).toBe("-A");
      expect(calls[2].args).toEqual(
        expect.arrayContaining(["-n", CA_CN, "-t", "CT,C,C", "-d", spec, "-i"]),
      );
      expect(calls[2].args[calls[2].args.length - 1]).toMatch(/bm-ca-.*\.pem$/);
      // The -N path really created the nssdb dir under the tmp home.
      expect(statSync(path.join(home, ".pki", "nssdb")).isDirectory()).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("installCa skips -N when the db already exists", async () => {
    const { runner, calls } = recordingPlatformRunner((file, args) => {
      if (args[0] === "-A") return ok("");
      if (args.includes("-a")) return ok(CA_PEM);
      return nssList("CT,C,C");
    });
    await expect(
      installCa(CA_PEM, { platformRunner: runner, homeDir: "/home/t", ...LINUX, ...noSystemStore }),
    ).resolves.toBe("installed");
    expect(calls.some((c) => c.args[0] === "-N")).toBe(false);
  });

  it("installCa without certutil + a present system store answers 'needs-admin'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-needadm-"));
    await expect(
      installCa(CA_PEM, {
        platformRunner: noCertutilRunner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: [dir], bundleFiles: [] },
      }),
    ).resolves.toBe("needs-admin");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("installCa without certutil and without any system paths answers 'unsupported'", async () => {
    await expect(
      installCa(CA_PEM, {
        platformRunner: noCertutilRunner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: ["/nonexistent"], bundleFiles: ["/nonexistent/x"] },
      }),
    ).resolves.toBe("unsupported");
  });

  it("removeCa deletes the nssdb row by nickname and re-verifies by fingerprint", async () => {
    let deleted = false;
    const { runner, calls } = recordingPlatformRunner((file, args) => {
      if (args[0] === "-D") {
        deleted = true;
        return ok("");
      }
      if (args.includes("-a")) return ok(deleted ? "" : CA_PEM);
      return nssList("CT,,");
    });
    await expect(
      removeCa(CA_PEM, { platformRunner: runner, homeDir: "/home/t", ...LINUX, ...noSystemStore }),
    ).resolves.toBe("removed");
    expect(calls.map((c) => c.args[0])).toContain("-D");
  });

  it("removeCa answers 'needs-admin' when the cert lives only in the system store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-linux-rm-"));
    const src = path.join(dir, "ca-certificates");
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, "blockingmachine-ca.crt"), CA_PEM);
    await expect(
      removeCa(CA_PEM, {
        platformRunner: noCertutilRunner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: [src], bundleFiles: [path.join(dir, "no-bundle.crt")] },
      }),
    ).resolves.toBe("needs-admin");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removeCa answers 'absent' when nothing holds the cert, and 'unsupported' with no store at all", async () => {
    const { runner } = recordingPlatformRunner(() => nssDbMissing());
    await expect(
      removeCa(CA_PEM, {
        platformRunner: runner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: ["/nonexistent"], bundleFiles: ["/nonexistent/x"] },
      }),
    ).resolves.toBe("absent");
    await expect(
      removeCa(CA_PEM, {
        platformRunner: noCertutilRunner,
        homeDir: "/home/t",
        ...LINUX,
        linuxSystemStore: { sourceDirs: ["/nonexistent"], bundleFiles: ["/nonexistent/x"] },
      }),
    ).resolves.toBe("unsupported");
  });
});

describe("firefoxNssProfileDbs + linuxSystemStoreCommands", () => {
  it("finds cert9.db files under the platform profile roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-ff-"));
    await fs.mkdir(path.join(dir, "abc.default-release"), { recursive: true });
    await fs.writeFile(path.join(dir, "abc.default-release", "cert9.db"), "x");
    await fs.mkdir(path.join(dir, "no-db.default"));
    const dbs = await firefoxNssProfileDbs({ profileRoots: [dir] });
    expect(dbs).toEqual([path.join(dir, "abc.default-release", "cert9.db")]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("renders the copy-pasteable system-store install/remove lines", () => {
    const cmds = linuxSystemStoreCommands("my ca.pem");
    expect(cmds.install).toBe(
      "sudo cp 'my ca.pem' /usr/local/share/ca-certificates/blockingmachine-ca.crt && sudo update-ca-certificates",
    );
    expect(cmds.remove).toBe(
      "sudo rm /usr/local/share/ca-certificates/blockingmachine-ca.crt && sudo update-ca-certificates",
    );
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
