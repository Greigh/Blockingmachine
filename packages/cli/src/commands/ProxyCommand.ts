import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  proxyControlRequest,
  type ProxyControlRequestOptions,
} from "../lib/proxyControl.js";
import { writeJson } from "../lib/logger.js";

/**
 * The P0 `/v1/proxy/*` surface (plan Task 8, spec §5.7). `pins` rides along
 * with the plan's four because `GET /v1/proxy/pins` shipped in the same P0
 * route table — the pin/bypass ledger is the one piece of engine state an
 * operator otherwise cannot see at all. Removing a pin is deliberately
 * absent: the P0 route table has no pin-removal endpoint (the full API's
 * `POST /v1/proxy/pins/{restore,remove}` is a later-phase route), and this
 * command does not invent endpoints.
 */
export type ProxyAction = "status" | "stats" | "pins" | "toggle" | "reload";

export interface ProxyCommandOptions {
  action: ProxyAction;
  /** Control port override — the engine defaults to 9293. */
  port?: number;
  /**
   * `toggle` only: an explicit target state (`--enable`/`--disable`) instead
   * of flipping — the API reads `{enabled:boolean}` when the body carries
   * one and flips on an absent body, which is what a bare `proxy toggle`
   * sends.
   */
  enable?: boolean;
}

const ACTIONS: Record<ProxyAction, { method: "GET" | "POST"; path: string }> = {
  status: { method: "GET", path: "/v1/proxy/status" },
  stats: { method: "GET", path: "/v1/proxy/stats" },
  pins: { method: "GET", path: "/v1/proxy/pins" },
  toggle: { method: "POST", path: "/v1/proxy/toggle" },
  reload: { method: "POST", path: "/v1/proxy/reload" },
};

export class ProxyCommand extends BaseCommand<ProxyCommandOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: ProxyCommandOptions): Promise<CommandResult> {
    const route = ACTIONS[options?.action];
    if (!route) {
      return this.failure(
        `Unknown proxy action "${options?.action}". Expected one of: ${Object.keys(ACTIONS).join(", ")}.`,
      );
    }

    const request: ProxyControlRequestOptions = {
      method: route.method,
      path: route.path,
      port: options.port,
    };
    if (route.path === "/v1/proxy/toggle" && options.enable !== undefined) {
      request.body = { enabled: options.enable };
    }

    try {
      const payload = await proxyControlRequest(request);
      // These commands exist to inspect a JSON control API, so the payload
      // IS the output — written by `writeJson`, which keeps stdout a clean
      // document a caller can pipe (the `--json` convention applied to the
      // command's only output mode).
      writeJson(payload);
      return this.success(payload, `Proxy ${options.action} completed`);
    } catch (error) {
      return this.handleError(error);
    }
  }
}
