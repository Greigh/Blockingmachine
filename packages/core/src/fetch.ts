import fetch, { RequestInfo, RequestInit, Response } from "node-fetch";
import { promises as fs } from "fs";
import path from "path";
import { dirname } from "path";

// --- Determine Base Directory ---
const getDirname = () => {
  // In CommonJS
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }

  // Fallback to current working directory
  return process.cwd();
};

const baseDir = path.resolve(getDirname(), ".."); // Go up one level from 'src'
// ---

const MAX_RETRIES = 3;
const INITIAL_DELAY = 2000;
const FETCH_TIMEOUT = 30000; // Define timeout duration

async function fetchWithRetry(
  url: RequestInfo,
  options: RequestInit,
  attempt = 1,
): Promise<string | null> {
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
    clearTimeout(timeoutId); // Clear timeout if fetch completes successfully

    if (!response.ok) {
      // Specific handling for common non-fatal errors
      if ([403, 404, 503].includes(response.status)) {
        console.warn(
          `⚠️ Received status ${response.status} for ${url}. Skipping retries for this status.`,
        );
        return null; // Treat as fetch failure but don't retry endlessly
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.text();
  } catch (error: any) {
    clearTimeout(timeoutId); // Clear timeout if fetch fails

    // Check if the error was due to the abort signal (timeout)
    if (error.name === "AbortError") {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} timed out for ${url} after ${FETCH_TIMEOUT}ms`,
      );
    } else if (error?.code === "ERR_INVALID_URL") {
      console.error(`❌ Invalid URL encountered: ${url}`);
      return null; // Don't retry invalid URLs
    } else {
      console.warn(
        `⚠️ Attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${error?.message || error}`,
      );
    }

    // Retry logic (only if not an invalid URL)
    if (error?.code !== "ERR_INVALID_URL" && attempt < MAX_RETRIES) {
      const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
      console.log(`⏳ Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Pass original options (without signal) to recursive call, it will create a new controller
      return fetchWithRetry(url, options, attempt + 1);
    } else {
      if (error?.code !== "ERR_INVALID_URL") {
        // Avoid double logging for invalid URL
        console.error(
          `❌ Max retries reached or non-retryable error for ${url}. Last error: ${error?.message || error}`,
        );
      }
      return null; // Return null after max retries
    }
  }
}

export async function fetchContent(url: string): Promise<string | null> {
  // Remove timeout from the base options object
  const options: RequestInit = {
    headers: {
      "User-Agent":
        "Blockingmachine/3.0 (+https://github.com/greigh/blockingmachine)",
    },
  };

  // --- Check if it's a local file path ---
  if (!url.startsWith("http:") && !url.startsWith("https:")) {
    try {
      // Resolve the path relative to the determined base directory
      const filePath = path.resolve(baseDir, url);
      console.log(`Reading local file: ${filePath}`);
      const content = await fs.readFile(filePath, "utf8");
      return content;
    } catch (error: any) {
      console.error(
        `❌ Error reading local file ${url} (resolved to ${path.resolve(
          baseDir,
          url,
        )}): ${error?.message || error}`,
      );
      return null;
    }
  } else {
    // Pass url and options; fetchWithRetry will handle the timeout internally
    return await fetchWithRetry(url, options);
  }
}
