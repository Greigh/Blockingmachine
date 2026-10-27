import { jest } from "@jest/globals";
import http from "http";
import { AddressInfo } from "net";
import { ProxyCommand } from "../commands/ProxyCommand.js";
import { captureStdout, parseJsonStdout } from "./captureStdout.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProxyCommand", () => {
  let mockLogger: any;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  const cmd = () =>
    new ProxyCommand({
      config: { baseDir: ".", sources: [] } as any,
      logger: mockLogger,
    });

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    fetchMock = jest.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  test("status GETs /v1/proxy/status on 127.0.0.1:9293 and prints the JSON payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "running",
        dataPort: 9294,
        controlPort: 9293,
        protectionEnabled: true,
        paused: false,
        rulesLoaded: 42,
      }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "status" });
      expect(result.success).toBe(true);
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/status");
    expect(init?.method ?? "GET").toBe("GET");

    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.status).toBe("running");
    expect(doc.rulesLoaded).toBe(42);
  });

  test("stats GETs /v1/proxy/stats", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { flowsTotal: 10, flowsBlocked: 3, paused: false }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "stats" });
      expect(result.success).toBe(true);
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/stats");
    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.flowsBlocked).toBe(3);
  });

  test("pins GETs /v1/proxy/pins and prints the ledger payload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        pins: [
          { ts: 1, host: "banking.example", action: "pin", reason: "handshake-abort" },
          { ts: 2, host: "printer.example", action: "bypass" },
        ],
        corruptLineCount: 0,
      }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "pins" });
      expect(result.success).toBe(true);
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/pins");
    const doc = parseJsonStdout<{ pins: { host: string; action: string }[] }>(stdout);
    expect(doc.pins.map((p) => p.host)).toEqual(["banking.example", "printer.example"]);
  });

  test("toggle POSTs with a JSON content type and an empty body (server flips)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, protectionEnabled: false, paused: true }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "toggle" });
      expect(result.success).toBe(true);
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/toggle");
    expect(init?.method).toBe("POST");
    // The API 415s any POST without this header — it is the guard that keeps
    // browser drive-bys out, and the client must always carry it.
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(parseJsonStdout<Record<string, unknown>>(stdout).paused).toBe(true);
  });

  test("toggle --enable/--disable sends an explicit {enabled} body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, protectionEnabled: true, paused: false }),
    );

    await captureStdout(async () => {
      const result = await cmd().execute({ action: "toggle", enable: true });
      expect(result.success).toBe(true);
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      enabled: true,
    });

    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, protectionEnabled: false, paused: true }),
    );
    await captureStdout(async () => {
      const result = await cmd().execute({ action: "toggle", enable: false });
      expect(result.success).toBe(true);
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      enabled: false,
    });
  });

  test("reload POSTs /v1/proxy/reload", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        message: "Reloaded 12000 rules",
        rulesLoaded: 12000,
        rulesSize: 12000,
      }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "reload" });
      expect(result.success).toBe(true);
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/reload");
    expect(init?.method).toBe("POST");
    expect(parseJsonStdout<Record<string, unknown>>(stdout).rulesLoaded).toBe(12000);
  });

  test("unpin POSTs /v1/proxy/pins/remove with the host body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        host: "banking.example",
        pinned: false,
        bypassed: false,
        entry: { ts: 9, host: "banking.example", action: "remove" },
      }),
    );

    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({ action: "unpin", host: "banking.example" });
      expect(result.success).toBe(true);
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/pins/remove");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ host: "banking.example" });
    const doc = parseJsonStdout<Record<string, unknown>>(stdout);
    expect(doc.success).toBe(true);
    expect(doc.pinned).toBe(false);
  });

  test("bypass POSTs /v1/proxy/pins/bypass — {host} bare, {host,reason} with a note", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        host: "printer.example",
        pinned: false,
        bypassed: true,
        entry: { ts: 10, host: "printer.example", action: "bypass" },
      }),
    );

    await captureStdout(async () => {
      const result = await cmd().execute({ action: "bypass", host: "printer.example" });
      expect(result.success).toBe(true);
    });
    let [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/pins/bypass");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ host: "printer.example" });

    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        host: "iot.example",
        pinned: false,
        bypassed: true,
        entry: { ts: 11, host: "iot.example", action: "bypass", reason: "smart tv" },
      }),
    );
    const stdout = await captureStdout(async () => {
      const result = await cmd().execute({
        action: "bypass",
        host: "iot.example",
        reason: "smart tv",
      });
      expect(result.success).toBe(true);
    });
    [url, init] = fetchMock.mock.calls[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      host: "iot.example",
      reason: "smart tv",
    });
    expect(parseJsonStdout<Record<string, unknown>>(stdout).bypassed).toBe(true);
  });

  test("bypass-remove POSTs /v1/proxy/pins/remove — the one retract verb", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        host: "printer.example",
        pinned: false,
        bypassed: false,
        entry: { ts: 12, host: "printer.example", action: "remove" },
      }),
    );

    await captureStdout(async () => {
      const result = await cmd().execute({
        action: "bypass-remove",
        host: "printer.example",
      });
      expect(result.success).toBe(true);
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9293/v1/proxy/pins/remove");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ host: "printer.example" });
  });

  test("a mutation without a host fails before any request goes out", async () => {
    for (const action of ["unpin", "bypass", "bypass-remove"] as const) {
      const result = await cmd().execute({ action });
      expect(result.success).toBe(false);
      expect(result.message).toContain("needs a host");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a mutation refusing 400 surfaces the server's own error text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: "host must be a non-empty hostname of at most 253 characters",
      }),
    );

    const result = await cmd().execute({ action: "bypass", host: "   " });
    expect(result.success).toBe(false);
    // The command's own pre-check trims to empty and fails first — no fetch.
    expect(fetchMock).not.toHaveBeenCalled();

    const result2 = await cmd().execute({ action: "unpin", host: "bad.example" });
    expect(result2.success).toBe(false);
    expect(result2.message).toContain("non-empty hostname");
  });

  test("--port is honored on the mutation verbs too", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, host: "x.example", pinned: false, bypassed: false }),
    );

    await captureStdout(async () => {
      const result = await cmd().execute({ action: "unpin", host: "x.example", port: 19293 });
      expect(result.success).toBe(true);
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:19293/v1/proxy/pins/remove");
  });

  test("--port override changes the URL the request goes to", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "paused" }));

    await captureStdout(async () => {
      const result = await cmd().execute({ action: "status", port: 19293 });
      expect(result.success).toBe(true);
    });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:19293/v1/proxy/status");
  });

  test("a 500 envelope fails with the server's own error text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(500, { success: false, error: "no rulesPath configured" }),
    );

    const result = await cmd().execute({ action: "reload" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("no rulesPath configured");
    expect(mockLogger.error).toHaveBeenCalled();
  });

  test("a non-JSON response body fails rather than rendering as a payload", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>not the proxy</html>", { status: 200 }),
    );

    const result = await cmd().execute({ action: "status" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("non-JSON");
  });

  test("an unreachable control port fails with a hint that the proxy is not running", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9293"));

    const result = await cmd().execute({ action: "status" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("is the HTTPS filter proxy running");
  });

  test("a 2xx with success:false still fails — the envelope, not the status, is the verdict", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: false, error: "engine wedged" }),
    );

    const result = await cmd().execute({ action: "toggle" });
    expect(result.success).toBe(false);
    expect(result.message).toContain("engine wedged");
  });

  test("an unknown action fails before any request goes out", async () => {
    const result = await cmd().execute({ action: "bogus" as any });
    expect(result.success).toBe(false);
    expect(result.message).toContain("Unknown proxy action");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("talks to a real control-shaped server on an overridden port", async () => {
    fetchMock.mockRestore();
    const seen: { method?: string; url?: string; contentType: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          contentType: String(req.headers["content-type"] || "").split(";")[0].trim(),
          body,
        });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (
          req.method === "POST" &&
          String(req.headers["content-type"] || "").split(";")[0].trim() !== "application/json"
        ) {
          send(415, { success: false, error: "Unsupported Media Type" });
          return;
        }
        if (req.url === "/v1/proxy/toggle") {
          send(200, { success: true, protectionEnabled: false, paused: true });
          return;
        }
        if (req.url === "/v1/proxy/status") {
          send(200, { status: "running", paused: false, rulesLoaded: 7 });
          return;
        }
        send(404, { error: "Not Found" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      let toggleResult: any, statusResult: any;
      const toggleOut = await captureStdout(async () => {
        toggleResult = await cmd().execute({ action: "toggle", port });
      });
      const statusOut = await captureStdout(async () => {
        statusResult = await cmd().execute({ action: "status", port });
      });
      expect(toggleResult.success).toBe(true);
      expect(statusResult.success).toBe(true);
      expect(parseJsonStdout<Record<string, unknown>>(toggleOut).paused).toBe(true);
      expect(parseJsonStdout<Record<string, unknown>>(statusOut).rulesLoaded).toBe(7);

      expect(seen[0].method).toBe("POST");
      expect(seen[0].contentType).toBe("application/json");
      expect(seen[1].method).toBe("GET");
      expect(seen[1].url).toBe("/v1/proxy/status");
    } finally {
      server.close();
    }
  });
});
