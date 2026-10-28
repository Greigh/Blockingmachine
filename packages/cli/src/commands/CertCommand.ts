import { X509Certificate } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import chalk from "chalk";
import {
  installCa,
  removeCa,
  trustStatus,
  firefoxNssProfileDbs,
  linuxSystemStoreCommands,
  linuxSystemStoreMechanism,
  type CaInstallOutcome,
  type CaRemoveOutcome,
  type CaTrustState,
} from "@blockingmachine/core";
import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  proxyControlRequest,
  type ProxyCaPayload,
} from "../lib/proxyControl.js";
import { writeJson } from "../lib/logger.js";

export type CertAction =
  | "status"
  | "export"
  | "trust-check"
  | "install"
  | "uninstall";

export interface CertCommandOptions {
  action: CertAction;
  /** Control port override — the engine defaults to 9293. */
  port?: number;
  /** `export` destination; absent writes the PEM to stdout for piping. */
  path?: string;
  json?: boolean;
}

export class CertCommand extends BaseCommand<CertCommandOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: CertCommandOptions): Promise<CommandResult> {
    const known: CertAction[] = [
      "status",
      "export",
      "trust-check",
      "install",
      "uninstall",
    ];
    if (!known.includes(options?.action)) {
      return this.failure(
        `Unknown cert action "${options?.action}". Expected: ${known.join(", ")}.`,
      );
    }

    let payload: ProxyCaPayload;
    try {
      payload = await proxyControlRequest<ProxyCaPayload>({
        method: "GET",
        path: "/v1/proxy/ca",
        port: options.port,
      });
    } catch (error) {
      return this.handleError(error);
    }

    if (options.action === "status") {
      if (options.json) {
        writeJson(payload);
      } else {
        this.printStatus(payload);
      }
      return this.success(payload, "CA status retrieved");
    }

    // Trust-store verbs — the PEM is fetched over the loopback control API
    // (public certificate material only), then the OS op runs locally through
    // core's caTrustStore. darwin/win32/linux are implemented; any other
    // platform reports 'unsupported' honestly rather than half-doing the work.
    if (options.action === "trust-check") {
      return this.runTrustCheck(payload, options.json);
    }
    if (options.action === "install") {
      return this.runInstall(payload, options.json);
    }
    if (options.action === "uninstall") {
      return this.runUninstall(payload, options.json);
    }

    // `export` — the PEM is a public certificate, written verbatim. A path
    // writes the file (the trust-install flows consume it); no path puts the
    // PEM on stdout so `cert export > ca.pem` composes like every other
    // machine-readable output here.
    const pem = payload.certPem.endsWith("\n")
      ? payload.certPem
      : `${payload.certPem}\n`;
    if (!options.path) {
      process.stdout.write(pem);
      return this.success(payload, "CA certificate written to stdout");
    }

    try {
      const target = path.resolve(process.cwd(), options.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, pem, "utf8");
      this.logger.info(`✓ CA certificate written to ${target}`);
      return this.success(
        { ...payload, path: target },
        `CA certificate written to ${target}`,
      );
    } catch (error) {
      return this.handleError(error);
    }
  }

  /** `cert trust-check` — probe the OS trust store for this exact CA. */
  private async runTrustCheck(
    payload: ProxyCaPayload,
    json?: boolean,
  ): Promise<CommandResult> {
    let state: CaTrustState;
    try {
      state = await trustStatus(payload.certPem);
    } catch (error) {
      return this.handleError(error);
    }
    const data = { ...payload, trustState: state };
    if (json) {
      writeJson(data);
    } else {
      console.log(
        `\n${chalk.bold.underline("Proxy CA trust state:")}\n\n  ${this.describeTrustState(state)}\n`,
      );
    }
    return this.success(data, `CA trust state: ${state}`);
  }

  /**
   * `cert install` — anchor the CA as a trust root in the OS store. On
   * darwin the `add-trusted-cert -d` write is itself the consent prompt when a
   * GUI session can service it; `needs-admin` means this context could not
   * (headless shell, locked keychain), so the command the user must run with
   * sudo is printed verbatim. linux `needs-admin` means the system-store
   * write (`sudo cp` + `update-ca-certificates`) needs root; win32's means
   * the machine-scope Root store wants an elevated prompt.
   */
  private async runInstall(
    payload: ProxyCaPayload,
    json?: boolean,
  ): Promise<CommandResult> {
    let outcome: CaInstallOutcome;
    try {
      outcome = await installCa(payload.certPem);
    } catch (error) {
      return this.handleError(error);
    }

    if (outcome === "installed") {
      const message = `CA installed into ${this.storeNoun()} and trusted.`;
      if (json) {
        writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
      } else {
        this.logger.info(`✓ ${message}`);
        await this.warnFirefoxNssGap();
      }
      return this.success({ result: outcome }, message);
    }

    if (outcome === "needs-admin") {
      const sudoCommand = await this.adminInstallCommand();
      const message =
        "Trust install needs administrator rights from this context. Run: " +
        sudoCommand;
      if (json) {
        writeJson({
          result: outcome,
          sha256Fingerprint: payload.sha256Fingerprint,
          sudoCommand,
        });
      } else {
        this.logger.warn(
          `The ${this.storeNoun()} refused the unprivileged install from this context.`,
        );
        this.logger.warn(`Run the admin form yourself:\n\n  ${sudoCommand}\n`);
        await this.warnFirefoxNssGap();
      }
      return this.failure(message);
    }

    const message = `OS trust-store ops are not implemented on ${process.platform} — this platform reports 'unsupported'.`;
    if (json) {
      writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
    } else {
      this.logger.error(message);
    }
    return this.failure(message);
  }

  /**
   * The manual escalation line for `needs-admin`, per platform:
   * - darwin: `sudo security add-trusted-cert` against the resolved login
   *   keychain path — the path is expanded here rather than left as "$HOME":
   *   under sudo -H (or any preserved-env posture) $HOME expands to the
   *   WRONG user's home, so the printed line names the concrete file the
   *   write targets.
   * - linux: `sudo cp` into the distro source dir + `update-ca-certificates`
   *   — or the RHEL-family `update-ca-trust` anchors pair when the box's
   *   store is the `/etc/pki` mechanism (flag 117; the mechanism probe
   *   picks the line core's `linuxSystemStoreCommands` renders).
   * - win32: elevated `certutil -addstore Root` — the MACHINE Root store
   *   (the user store refused), covering every account on the box.
   * `cert export` precedes each pair so the pem the line consumes exists.
   */
  private async adminInstallCommand(): Promise<string> {
    const exportStep = "blockingmachine cert export ca.pem";
    if (process.platform === "linux") {
      const mechanism = await this.linuxMechanism();
      return `${exportStep} && ${linuxSystemStoreCommands("ca.pem", mechanism).install}`;
    }
    if (process.platform === "win32") {
      return `${exportStep}, then 'certutil -addstore Root ca.pem' from an elevated prompt`;
    }
    const keychainPath = path.join(
      process.env.HOME ?? os.homedir(),
      "Library",
      "Keychains",
      "login.keychain-db",
    );
    return (
      `${exportStep} && ` +
      `sudo security add-trusted-cert -d -r trustRoot -k '${keychainPath.replace(/'/g, `'\\''`)}' ca.pem`
    );
  }

  /** `cert uninstall` — drop the CA's trust settings and store entry. */
  private async runUninstall(
    payload: ProxyCaPayload,
    json?: boolean,
  ): Promise<CommandResult> {
    let outcome: CaRemoveOutcome;
    try {
      outcome = await removeCa(payload.certPem);
    } catch (error) {
      return this.handleError(error);
    }

    if (outcome === "unsupported") {
      const message = `OS trust-store ops are not implemented on ${process.platform} — this platform reports 'unsupported'.`;
      if (json) {
        writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
      } else {
        this.logger.error(message);
      }
      return this.failure(message);
    }

    if (outcome === "needs-admin") {
      // linux: the cert lives in a distro system store — `sudo rm` +
      // `update-ca-certificates`/`update-ca-trust extract` is the removal
      // (mechanism picked by the same probe install uses); win32: elevation
      // denied.
      const line =
        process.platform === "linux"
          ? linuxSystemStoreCommands("ca.pem", await this.linuxMechanism()).remove
          : process.platform === "win32"
            ? "certutil -delstore Root <sha1-thumbprint> from an elevated prompt"
            : "an administrator session";
      const message = `CA removal needs administrator rights from this context. Run: ${line}`;
      if (json) {
        writeJson({
          result: outcome,
          sha256Fingerprint: payload.sha256Fingerprint,
          sudoCommand: line,
        });
      } else {
        this.logger.warn(`Run the admin form yourself:\n\n  ${line}\n`);
      }
      return this.failure(message);
    }

    const message =
      outcome === "removed"
        ? "CA trust settings and store entry removed."
        : `CA was not present in ${this.storeNoun()} — nothing to remove.`;
    if (json) {
      writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
    } else {
      this.logger.info(`✓ ${message}`);
    }
    return this.success({ result: outcome }, message);
  }

  /**
   * Which linux system-store write path the printed sudo line names — the
   * probe `installCa`/`removeCa` ran internally, re-asked so the rendered
   * command matches the box's real store. A probe that cannot answer
   * (foreign platform, dead runner) falls back to the Debian line the
   * pre-flag-117 behavior printed.
   */
  private async linuxMechanism() {
    return (await linuxSystemStoreMechanism().catch(() => null)) ?? "debian";
  }

  /** The OS store the platform's trust ops write — keeps prose honest. */
  private storeNoun(): string {
    return process.platform === "darwin"
      ? "login keychain"
      : process.platform === "win32"
        ? "Windows user Root store"
        : process.platform === "linux"
          ? "NSS db / system trust store"
          : "OS trust store";
  }

  /**
   * Firefox ships its own NSS cert9.db that no OS-store write reaches —
   * name the gap when a profile exists so a successful install does not
   * overclaim (known-issues 116, firefox-nss-cert9). darwin's posture predates
   * P3 and is left as-is.
   */
  private async warnFirefoxNssGap(): Promise<void> {
    if (process.platform === "darwin") return;
    let dbs: string[] = [];
    try {
      dbs = await firefoxNssProfileDbs();
    } catch {
      return;
    }
    if (dbs.length === 0) return;
    this.logger.warn(
      "Firefox keeps its own certificate store — enable " +
        "security.enterprise_roots.enabled there or import the CA into its cert9.db manually.",
    );
  }

  private describeTrustState(state: CaTrustState): string {
    const store = this.storeNoun();
    switch (state) {
      case "trusted":
        return `${chalk.green("trusted")} — the CA anchors TLS verification on this machine.`;
      case "installed-untrusted":
        return (
          `${chalk.yellow("installed-untrusted")} — present in the ${store} but not ` +
          `anchored as a trust root; run ${chalk.bold("cert install")} to trust it.`
        );
      case "absent":
        return (
          `${chalk.yellow("absent")} — not in the ${store}; run ` +
          `${chalk.bold("cert install")} to trust it.`
        );
      case "unsupported":
        return `unsupported — OS trust-store ops are not implemented on ${process.platform}.`;
      default:
        // Unreachable per the union; keep a string so a widened caller
        // still gets a printable line rather than undefined.
        return String(state);
    }
  }

  /**
   * The fingerprint is the identity a trust install must verify, so it leads
   * the report; the validity window comes from the payload's `notAfter` plus
   * a local `validFrom` read out of the PEM — the route does not carry it,
   * but the certificate it just handed over does.
   */
  private printStatus(payload: ProxyCaPayload): void {
    let validFrom: string | null = null;
    try {
      validFrom = new X509Certificate(payload.certPem).validFrom;
    } catch {
      // A PEM the platform parser rejects still gets its payload fields
      // printed — the fingerprint and notAfter are the route's own words.
    }
    console.log("\n" + chalk.bold.underline("Proxy CA certificate:") + "\n");
    console.log(`  SHA-256 fingerprint: ${chalk.bold(payload.sha256Fingerprint)}`);
    if (validFrom) {
      console.log(`  Valid from:          ${validFrom}`);
    }
    console.log(`  Valid until:         ${payload.notAfter}`);
    // At-rest posture of the CA private key — OS-wrapped behind the named
    // backend, or the legacy 0600 plaintext file when no backend exists.
    const keyAtRest = payload.keyWrapped
      ? `OS-wrapped${payload.keyWrapBackend ? ` (${payload.keyWrapBackend})` : ""}`
      : "plaintext (0600)";
    console.log(`  CA key at rest:      ${keyAtRest}`);
    console.log("");
  }
}
