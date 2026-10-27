import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  proxyControlRequest,
  type ProxyControlRequestOptions,
  type ProxyPinMutationPayload,
} from "../lib/proxyControl.js";
import { writeJson } from "../lib/logger.js";

/**
 * The `/v1/proxy/*` surface (plan Task 8, spec §5.7). `pins` lists the
 * pin/bypass ledger — the one piece of engine state an operator otherwise
 * cannot see — and the `host` mutations write to it: `unpin` retracts a
 * learned pin, `bypass` records a user-directed tunnel-without-verdict, and
 * `bypass-remove` retracts a bypass. Both retractions ride
 * `POST /v1/proxy/pins/remove` because `PolicyStore.remove` clears the host
 * from BOTH sets — it is the ledger's one "retract this host's policy"
 * verb, and a route the API did not have until flags 95/98.
 */
export type ProxyAction =
  | "status"
  | "stats"
  | "pins"
  | "toggle"
  | "reload"
  | "unpin"
  | "bypass"
  | "bypass-remove";

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
  /**
   * `unpin`/`bypass`/`bypass-remove`: the ledger host the mutation covers.
   * Sent raw — normalization (trim+lowercase) is the store's, applied
   * server-side.
   */
  host?: string;
  /**
   * All three ledger mutations: an optional short note the ledger line
   * records (`remove` accepts it exactly like `bypass` does).
   */
  reason?: string;
}

interface ProxyRoute {
  method: "GET" | "POST";
  path: string;
  /** True when the action writes the pin/bypass ledger and needs `<host>`. */
  host?: true;
}

const ACTIONS: Record<ProxyAction, ProxyRoute> = {
  status: { method: "GET", path: "/v1/proxy/status" },
  stats: { method: "GET", path: "/v1/proxy/stats" },
  pins: { method: "GET", path: "/v1/proxy/pins" },
  toggle: { method: "POST", path: "/v1/proxy/toggle" },
  reload: { method: "POST", path: "/v1/proxy/reload" },
  unpin: { method: "POST", path: "/v1/proxy/pins/remove", host: true },
  bypass: { method: "POST", path: "/v1/proxy/pins/bypass", host: true },
  "bypass-remove": { method: "POST", path: "/v1/proxy/pins/remove", host: true },
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
    if (route.host === true) {
      // The API rejects an absent/empty host with a 400 — refuse it here
      // first so the failure names the missing argument, not the route.
      const host = typeof options.host === "string" ? options.host.trim() : "";
      if (host === "") {
        return this.failure(
          `proxy ${options.action} needs a host — e.g. \`proxy ${options.action} example.com\`.`,
        );
      }
      request.body =
        options.reason !== undefined ? { host, reason: options.reason } : { host };
    }

    try {
      const payload = route.host
        ? await proxyControlRequest<ProxyPinMutationPayload>(request)
        : await proxyControlRequest(request);
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
