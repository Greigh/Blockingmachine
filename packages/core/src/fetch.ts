import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Readable } from "stream";

import { isSafePublicWebUrl } from "./utils/urlSafety.js";


const MAX_RETRIES = 3;
const INITIAL_DELAY = 2000;
const FETCH_TIMEOUT = 30000; // Define timeout duration
const MAX_PAYLOAD_SIZE = 100 * 1024 * 1024; // 100MB max payload limit
const MAX_REDIRECTS = 5;

class NonRetryableFetchError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export interface FetchOptions {
  etag?: string;
  lastModified?: string;
  allowPrivateNetworks?: boolean;
  expectedSha256?: string;
}

export interface FetchResult {
  content: string | null;
  notModified: boolean;
  etag?: string | null;
  lastModified?: string | null;
  sha256?: string | null;
  status: number;
}

async function fetchWithRetry(
  url: RequestInfo,
  options: RequestInit,
  attempt = 1,
  redirectCount = 0,
  allowPrivateNetworks = false,
): Promise<FetchResult> {
  // --- Timeout Controller ---
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let response: Response | undefined;
  const cleanup = () => {
    clearTimeout(timeoutId);
    // Every early return must release the unread body and the underlying request.
    if (response?.body instanceof Readable) response.body.destroy();
    controller.abort();
  };
  // Add the signal to the fetch options with manual redirect inspection
  const fetchOptions: RequestInit = {
    ...options,
    redirect: "manual",
    signal: controller.signal,
  };
  // ---

  try {
    // Use the options with the AbortSignal
    response = await fetch(url, fetchOptions);

    if (response.status === 304) {
      return {
        content: null,
        notModified: true,
        etag: response.headers.get("etag") || undefined,
        lastModified: response.headers.get("last-modified") || undefined,
        status: 304,
      };
    }

    // Check redirect URLs using the same lexical policy as the original URL.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw new NonRetryableFetchError(`Too many redirects (limit ${MAX_REDIRECTS}) for ${url}`);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new NonRetryableFetchError(`Redirect status ${response.status} missing Location header for ${url}`);
      }
      const parsedRedirect = new URL(location, String(url));
      const nextUrl = parsedRedirect.toString();
      if (parsedRedirect.protocol !== "http:" && parsedRedirect.protocol !== "https:") {
        throw new NonRetryableFetchError(
          `URL guard blocked redirect from ${url} to non-HTTP(S) URL ${nextUrl}`,
          403,
        );
      }
      if (!allowPrivateNetworks) {
        const redirectSafety = isSafePublicWebUrl(nextUrl);
        if (!redirectSafety.isSafe) {
          throw new NonRetryableFetchError(
            `URL guard blocked redirect from ${url} to ${nextUrl}: ${redirectSafety.reason}`,
            403,
          );
        }
      }
      cleanup();
      return fetchWithRetry(nextUrl, options, attempt, redirectCount + 1, allowPrivateNetworks);
    }

    if (!response.ok) {
      // Specific handling for common non-fatal errors
      if ([403, 404, 503].includes(response.status)) {
        console.warn(
          `⚠️ Received status ${response.status} for ${url}. Skipping retries for this status.`,
        );
        return { content: null, notModified: false, status: response.status };
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
      throw new NonRetryableFetchError(
        `Response payload exceeds limit of 100MB: ${contentLength} bytes`,
        413,
      );
    }

    let textContent: string;
    if (
      response.body &&
      typeof (response.body as any)[Symbol.asyncIterator] === "function"
    ) {
      let totalBytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body as any) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_PAYLOAD_SIZE) {
          controller.abort();
          throw new NonRetryableFetchError(
            `Response payload exceeded limit of 100MB: >${totalBytes} bytes`,
            413,
          );
        }
        chunks.push(buf);
      }
      textContent = Buffer.concat(chunks).toString("utf-8");
    } else {
      textContent = await response.text();
    }

    const computedSha256 = crypto
      .createHash("sha256")
      .update(textContent, "utf8")
      .digest("hex");

    return {
      content: textContent,
      notModified: false,
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined,
      sha256: computedSha256,
      status: response.status,
    };
  } catch (error: any) {
    cleanup();

    // Check if the error was due to the abort signal (timeout)
    if (error.name === "AbortError") {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} timed out for ${url} after ${FETCH_TIMEOUT}ms`,
      );
    } else if (error?.code === "ERR_INVALID_URL") {
      console.error(`❌ Invalid URL encountered: ${url}`);
      return { content: null, notModified: false, status: 400 };
    } else if (error instanceof NonRetryableFetchError) {
      console.error(`❌ ${error.message}`);
      return { content: null, notModified: false, status: error.status };
    } else {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${error?.message || error}`,
      );
    }

    // Retry only failures that can be transient, after closing the previous response.
    if (attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
      console.log(`⏳ Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Pass original options (without signal) to recursive call, it will create a new controller
      return fetchWithRetry(url, options, attempt + 1, redirectCount, allowPrivateNetworks);
    } else {
      console.error(
        `❌ Max retries reached for ${url}. Last error: ${error?.message || error}`,
      );
      return {
        content: null,
        notModified: false,
        status: 0,
      };
    }
  } finally {
    cleanup();
  }
}

export async function fetchWithConditionalCache(
  url: string,
  cacheOptions?: FetchOptions,
): Promise<FetchResult> {
  if (!url || typeof url !== "string" || /[\0\r\n]/.test(url)) {
    return { content: null, notModified: false, status: 400 };
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Blockingmachine/3.0 (+https://github.com/greigh/blockingmachine)",
  };

  if (cacheOptions?.etag) {
    headers["If-None-Match"] = cacheOptions.etag;
  }
  if (cacheOptions?.lastModified) {
    headers["If-Modified-Since"] = cacheOptions.lastModified;
  }

  const options: RequestInit = { headers };

  // --- Check if it's a local file path ---
  if (!/^https?:/i.test(url.trim())) {
    try {
      let filePath = url;
      if (url.startsWith("file://")) {
        filePath = fileURLToPath(url);
      } else if (!path.isAbsolute(url)) {
        filePath = path.resolve(process.cwd(), url);
      }

      // Security Guard: Block path traversal and access to sensitive system directories/credentials
      const normalized = path.normalize(filePath);
      const isSensitiveSystemPath =
        normalized.startsWith('/etc/') ||
        normalized === '/etc' ||
        normalized.startsWith('/proc/') ||
        normalized.startsWith('/sys/') ||
        normalized.includes('/.ssh/') ||
        normalized.endsWith('/.ssh') ||
        normalized.includes('/.aws/') ||
        normalized.endsWith('/.env');

      if (isSensitiveSystemPath) {
        console.error(`❌ Access denied to restricted system path: ${url}`);
        return { content: null, notModified: false, status: 403 };
      }

      // Read file content directly to prevent check-before-use race condition
      const content = await fs.readFile(filePath, "utf8");

      if (Buffer.byteLength(content, "utf8") > MAX_PAYLOAD_SIZE) {
        console.error(
          `❌ Local file exceeds 100MB limit: ${filePath}`,
        );
        return { content: null, notModified: false, status: 413 };
      }

      const computedSha256 = crypto
        .createHash("sha256")
        .update(content, "utf8")
        .digest("hex");

      if (cacheOptions?.expectedSha256) {
        if (
          computedSha256.toLowerCase() !==
          cacheOptions.expectedSha256.trim().toLowerCase()
        ) {
          console.error(
            `❌ Checksum mismatch for local file ${url}: expected ${cacheOptions.expectedSha256} but got ${computedSha256}`,
          );
          return {
            content: null,
            notModified: false,
            sha256: computedSha256,
            status: 422,
          };
        }
      }

      // Query metadata after reading for conditional cache inspection
      const stat = await fs.stat(filePath);
      const fileLastModified = stat.mtime.toUTCString();
      if (
        cacheOptions?.lastModified &&
        new Date(fileLastModified) <= new Date(cacheOptions.lastModified)
      ) {
        return {
          content: null,
          notModified: true,
          lastModified: fileLastModified,
          sha256: computedSha256,
          status: 304,
        };
      }

      return {
        content,
        notModified: false,
        lastModified: fileLastModified,
        sha256: computedSha256,
        status: 200,
      };
    } catch (error: any) {
      if (error?.code === "EISDIR") {
        return { content: null, notModified: false, status: 404 };
      }
      console.error(
        `❌ Error reading local file ${url}: ${error?.message || error}`,
      );
      return { content: null, notModified: false, status: 500 };
    }
  } else {
    url = url.trim();
    const allowPrivate = cacheOptions?.allowPrivateNetworks ?? false;
    if (!allowPrivate) {
      const safety = isSafePublicWebUrl(url);
      if (!safety.isSafe) {
        if (safety.reason === 'Malformed or invalid URL') {
          console.error(`❌ Invalid URL encountered: ${url}`);
          return { content: null, notModified: false, status: 400 };
        }
        console.error(
          `❌ URL guard blocked fetch request to ${url}: ${safety.reason}`,
        );
        return { content: null, notModified: false, status: 403 };
      }
    }
    const result = await fetchWithRetry(url, options, 1, 0, allowPrivate);
    if (result.notModified) {
      result.etag ??= cacheOptions?.etag;
      result.lastModified ??= cacheOptions?.lastModified;
    }
    if (result.content !== null && cacheOptions?.expectedSha256) {
      const computedSha256 =
        result.sha256 ||
        crypto.createHash("sha256").update(result.content, "utf8").digest("hex");
      if (
        computedSha256.toLowerCase() !==
        cacheOptions.expectedSha256.trim().toLowerCase()
      ) {
        console.error(
          `❌ Checksum mismatch for ${url}: expected ${cacheOptions.expectedSha256} but got ${computedSha256}`,
        );
        return {
          content: null,
          notModified: false,
          sha256: computedSha256,
          status: 422,
        };
      }
    }
    return result;
  }
}

export async function fetchContent(
  url: string,
  options?: FetchOptions,
): Promise<string | null> {
  const result = await fetchWithConditionalCache(url, options);
  return result.content;
}
