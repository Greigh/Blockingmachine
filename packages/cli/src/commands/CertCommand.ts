import { X509Certificate } from "crypto";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import {
  installCa,
  removeCa,
  trustStatus,
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
    // core's caTrustStore. darwin only today; every other platform reports
    // 'unsupported' honestly rather than half-doing the work.
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
   * `cert install` — anchor the CA as a trust root in the login keychain. On
   * darwin the `add-trusted-cert -d` write is itself the consent prompt when a
   * GUI session can service it; `needs-admin` means this context could not
   * (headless shell, locked keychain), so the command the user must run with
   * sudo is printed verbatim.
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
      const message = "CA installed into the login keychain and trusted.";
      if (json) {
        writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
      } else {
        this.logger.info(`✓ ${message}`);
      }
      return this.success({ result: outcome }, message);
    }

    if (outcome === "needs-admin") {
      // `cert export` writes the PEM the sudo line consumes — keep the pair
      // copy-pasteable as one shell command.
      const sudoCommand =
        "blockingmachine cert export ca.pem && " +
        'sudo security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" ca.pem';
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
          "The keychain refused the unprivileged install (headless or locked session).",
        );
        this.logger.warn(`Run the admin form yourself:\n\n  ${sudoCommand}\n`);
      }
      return this.failure(message);
    }

    const message =
      "OS trust-store ops are only implemented for macOS — this platform reports 'unsupported'.";
    if (json) {
      writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
    } else {
      this.logger.error(message);
    }
    return this.failure(message);
  }

  /** `cert uninstall` — drop the CA's trust settings and keychain entry. */
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
      const message =
        "OS trust-store ops are only implemented for macOS — this platform reports 'unsupported'.";
      if (json) {
        writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
      } else {
        this.logger.error(message);
      }
      return this.failure(message);
    }

    const message =
      outcome === "removed"
        ? "CA trust settings and keychain entry removed."
        : "CA was not present in the keychain — nothing to remove.";
    if (json) {
      writeJson({ result: outcome, sha256Fingerprint: payload.sha256Fingerprint });
    } else {
      this.logger.info(`✓ ${message}`);
    }
    return this.success({ result: outcome }, message);
  }

  private describeTrustState(state: CaTrustState): string {
    switch (state) {
      case "trusted":
        return `${chalk.green("trusted")} — the CA anchors TLS verification on this Mac.`;
      case "installed-untrusted":
        return (
          `${chalk.yellow("installed-untrusted")} — present in the keychain but not ` +
          `anchored as a trust root; run ${chalk.bold("cert install")} to trust it.`
        );
      case "absent":
        return (
          `${chalk.yellow("absent")} — not in the macOS keychain; run ` +
          `${chalk.bold("cert install")} to trust it.`
        );
      case "unsupported":
        return "unsupported — OS trust-store ops are only implemented for macOS.";
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
