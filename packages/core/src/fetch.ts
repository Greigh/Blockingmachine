import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Determine Base Directory ---
const getBaseDir = (): string => {
  try {
    if (typeof __dirname !== "undefined") {
      return path.resolve(__dirname, "..");
    }
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    }
  } catch {
    // fallback
  }
  return process.cwd();
};

const MAX_RETRIES = 3;
const INITIAL_DELAY = 2000;
const FETCH_TIMEOUT = 30000; // Define timeout duration
const MAX_PAYLOAD_SIZE = 100 * 1024 * 1024; // 100MB max payload limit

export interface FetchOptions {
  etag?: string;
  lastModified?: string;
}

export interface FetchResult {
  content: string | null;
  notModified: boolean;
  etag?: string | null;
  lastModified?: string | null;
  status: number;
}

async function fetchWithRetry(
  url: RequestInfo,
  options: RequestInit,
  attempt = 1,
): Promise<FetchResult> {
  // --- Timeout Controller ---
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  // Add the signal to the fetch options
  const fetchOptions: RequestInit = {
    ...options,
    signal: controller.signal,
  };
  // ---

  try {
    // Use the options with the AbortSignal
    const response: Response = await fetch(url, fetchOptions);

    if (response.status === 304) {
      return {
        content: null,
        notModified: true,
        etag: response.headers.get("etag") || undefined,
        lastModified: response.headers.get("last-modified") || undefined,
        status: 304,
      };
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
      throw new Error(
        `Response payload exceeds limit of 100MB: ${contentLength} bytes`,
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
          throw new Error(
            `Response payload exceeded limit of 100MB: >${totalBytes} bytes`,
          );
        }
        chunks.push(buf);
      }
      textContent = Buffer.concat(chunks).toString("utf-8");
    } else {
      textContent = await response.text();
    }

    return {
      content: textContent,
      notModified: false,
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined,
      status: response.status,
    };
  } catch (error: any) {
    // Check if the error was due to the abort signal (timeout)
    if (error.name === "AbortError") {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} timed out for ${url} after ${FETCH_TIMEOUT}ms`,
      );
    } else if (error?.code === "ERR_INVALID_URL") {
      console.error(`❌ Invalid URL encountered: ${url}`);
      return { content: null, notModified: false, status: 400 };
    } else {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${error?.message || error}`,
      );
    }

    const isPayloadOverflow =
      typeof error?.message === "string" &&
      error.message.includes("exceed") &&
      error.message.includes("100MB");
    const isNonRetryable =
      error?.code === "ERR_INVALID_URL" ||
      isPayloadOverflow ||
      error?.status === 413;

    // Retry logic (only if not a permanent non-retryable error)
    if (!isNonRetryable && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
      console.log(`⏳ Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Pass original options (without signal) to recursive call, it will create a new controller
      return fetchWithRetry(url, options, attempt + 1);
    } else {
      if (error?.code !== "ERR_INVALID_URL") {
        console.error(
          `❌ Max retries reached or non-retryable error for ${url}. Last error: ${error?.message || error}`,
        );
      }
      return {
        content: null,
        notModified: false,
        status: isPayloadOverflow ? 413 : error?.code === "ERR_INVALID_URL" ? 400 : 0,
      };
    }
  } finally {
    clearTimeout(timeoutId);
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
  if (!url.startsWith("http:") && !url.startsWith("https:")) {
    try {
      let filePath = url;
      if (url.startsWith("file://")) {
        filePath = fileURLToPath(url);
      } else if (!path.isAbsolute(url)) {
        const baseCandidate = path.resolve(getBaseDir(), url);
        const cwdCandidate = path.resolve(process.cwd(), url);
        filePath = baseCandidate;
        try {
          await fs.access(filePath);
        } catch {
          filePath = cwdCandidate;
        }
      }

      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        console.error(`❌ Local path is not a file: ${filePath}`);
        return { content: null, notModified: false, status: 404 };
      }
      if (stat.size > MAX_PAYLOAD_SIZE) {
        console.error(
          `❌ Local file exceeds 100MB limit: ${filePath} (${stat.size} bytes)`,
        );
        return { content: null, notModified: false, status: 413 };
      }

      const fileLastModified = stat.mtime.toUTCString();
      if (
        cacheOptions?.lastModified &&
        new Date(fileLastModified) <= new Date(cacheOptions.lastModified)
      ) {
        return {
          content: null,
          notModified: true,
          lastModified: fileLastModified,
          status: 304,
        };
      }

      const content = await fs.readFile(filePath, "utf8");
      return {
        content,
        notModified: false,
        lastModified: fileLastModified,
        status: 200,
      };
    } catch (error: any) {
      console.error(
        `❌ Error reading local file ${url}: ${error?.message || error}`,
      );
      return { content: null, notModified: false, status: 500 };
    }
  } else {
    return await fetchWithRetry(url, options);
  }
}

export async function fetchContent(url: string): Promise<string | null> {
  const result = await fetchWithConditionalCache(url);
  return result.content;
}
