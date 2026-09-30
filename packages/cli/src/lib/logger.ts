import winston from "winston";

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  debug: "blue",
};

winston.addColors(colors);

const format = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const splat = (info as any)[Symbol.for("splat")];
    const extra =
      splat && splat.length
        ? " " +
          splat
            .map((s: any) =>
              s instanceof Error
                ? s.stack || s.message
                : typeof s === "object"
                  ? JSON.stringify(s)
                  : String(s),
            )
            .join(" ")
        : "";
    return `${info.timestamp} ${info.level}: ${info.message}${extra}`;
  }),
);

/**
 * Writes a machine-readable result to stdout, bypassing the human log formatter entirely.
 *
 * `--json` output has to be a JSON document and nothing else, and the console transport cannot be
 * asked for that: it prefixes a timestamp and a colourised level, and `colorize({ all: true })`
 * wraps the whole message in ANSI escapes. Routing a payload through `logger.info` therefore made
 * every `--json` path unparseable — `JSON.parse` of the output failed on the timestamp, not on the
 * payload — which is a defect a machine consumer cannot work around and a human reader would never
 * notice. The two outputs are different formats rather than two settings of one, so they leave by
 * different doors: the human log keeps its colours, and the payload goes to stdout untouched.
 *
 * The file transports are deliberately not used either. A parseable result is what the caller asked
 * for, and it belongs on stdout where the shell can pipe it.
 */
export function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

let cachedLogger: winston.Logger | null = null;
let cachedDebug: boolean | null = null;

export function createLogger(debug = false) {
  if (cachedLogger && cachedDebug === debug) {
    return cachedLogger;
  }
  if (cachedLogger) {
    cachedLogger.level = debug ? "debug" : "info";
    cachedDebug = debug;
    return cachedLogger;
  }

  cachedDebug = debug;
  cachedLogger = winston.createLogger({
    level: debug ? "debug" : "info",
    levels,
    format,
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: "logs/error.log",
        level: "error",
      }),
      new winston.transports.File({
        filename: "logs/combined.log",
      }),
    ],
  });
  return cachedLogger;
}

export type Logger = ReturnType<typeof createLogger>;
