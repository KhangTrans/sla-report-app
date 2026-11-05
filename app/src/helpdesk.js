// Robust helpdesk API client with retry, backoff, and rate limit handling.
export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
    maxRetries = 5,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.maxRetries = maxRetries;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // GET a path (e.g. "/some/endpoint") with optional query params; returns parsed JSON.
  async get(pathname, params = {}) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }

    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
        });

        if (res.ok) {
          return await res.json();
        }

        // Handle Rate Limit (429)
        if (res.status === 429) {
          const retryAfterSec = parseInt(res.headers.get("Retry-After") || "2", 10);
          const waitMs = (isNaN(retryAfterSec) ? 2 : retryAfterSec) * 1000 + 200;
          console.warn(`[HelpdeskClient] Rate limited (429). Retrying after ${waitMs}ms...`);
          await this.sleep(waitMs);
          continue;
        }

        // Handle Transient Server Errors (500, 502, 503, 504)
        if (res.status >= 500 && attempt <= this.maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.floor(Math.random() * 300);
          console.warn(`[HelpdeskClient] Server error (${res.status}) on attempt ${attempt}. Retrying in ${backoffMs}ms...`);
          await this.sleep(backoffMs);
          continue;
        }

        const body = await res.text();
        const err = new Error(`Helpdesk API GET ${url} failed: ${res.status} ${body}`);
        err.status = res.status;
        err.body = body;
        throw err;
      } catch (err) {
        if (err.status) {
          throw err;
        }
        // Network/fetch errors (e.g. ECONNRESET, fetch failed)
        if (attempt <= this.maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt - 1);
          console.warn(`[HelpdeskClient] Network error "${err.message}". Retrying in ${backoffMs}ms...`);
          await this.sleep(backoffMs);
          continue;
        }
        throw err;
      }
    }
  }
}
