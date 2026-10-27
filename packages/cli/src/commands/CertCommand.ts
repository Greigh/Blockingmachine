import { X509Certificate } from "crypto";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
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

export type CertAction = "status" | "export";

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
    if (options?.action !== "status" && options?.action !== "export") {
      return this.failure(
        `Unknown cert action "${options?.action}". Expected: status, export.`,
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
    console.log("");
  }
}
