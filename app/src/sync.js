export class SyncEngine {
  constructor({ client, store, pollIntervalMs = 10000 }) {
    this.client = client;
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.isPolling = false;
    this.timer = null;
  }

  async fetchMetadata() {
    console.log("[SyncEngine] Fetching metadata (sites, holidays, staff, statuses)...");
    const [sitesRes, staffRes, statusesRes] = await Promise.all([
      this.client.get("/v1/sites"),
      this.client.get("/v1/staff"),
      this.client.get("/v1/statuses"),
    ]);

    this.store.setSites(sitesRes.data || []);
    this.store.setStaff(staffRes.data || []);
    this.store.setStatuses(statusesRes.data || []);

    // Fetch holidays for each site
    for (const site of sitesRes.data || []) {
      const holidaysRes = await this.client.get(`/v1/sites/${site.id}/holidays`);
      this.store.setHolidays(site.id, holidaysRes.data || []);
    }
    console.log("[SyncEngine] Metadata fetched successfully.");
  }

  async initialSync() {
    await this.fetchMetadata();

    console.log("[SyncEngine] Starting initial changes bootstrap...");
    const t0 = Date.now();
    let cursor = null;
    let totalItems = 0;
    let batchCount = 0;

    while (true) {
      const params = { limit: 500 };
      if (cursor) params.cursor = cursor;

      let res;
      try {
        res = await this.client.get("/v1/changes", params);
      } catch (err) {
        if (err.status === 410) {
          console.warn("[SyncEngine] Cursor expired during initial sync. Restarting from head...");
          cursor = null;
          continue;
        }
        throw err;
      }

      for (const item of res.data) {
        this.store.applyChange(item);
      }

      totalItems += res.data.length;
      cursor = res.next_cursor;
      this.store.latestCursor = cursor;
      batchCount++;

      if (batchCount % 20 === 0) {
        console.log(`[SyncEngine] Bootstrap progress: ${totalItems} changes ingested (${batchCount} batches, ${Date.now() - t0}ms)...`);
      }

      if (!res.has_more) {
        break;
      }
    }

    this.store.isReady = true;
    console.log(`[SyncEngine] Bootstrap complete! Ingested ${totalItems} changes in ${Date.now() - t0}ms. Store is READY.`);
  }

  async pollNewChanges() {
    if (!this.store.isReady) return;

    try {
      while (true) {
        const params = { limit: 500 };
        if (this.store.latestCursor) {
          params.cursor = this.store.latestCursor;
        }

        let res;
        try {
          res = await this.client.get("/v1/changes", params);
        } catch (err) {
          if (err.status === 410) {
            console.warn("[SyncEngine] Cursor expired (410). Resetting cursor...");
            this.store.latestCursor = null;
            break;
          }
          throw err;
        }

        if (res.data && res.data.length > 0) {
          console.log(`[SyncEngine] Live update: received ${res.data.length} new changes.`);
          for (const item of res.data) {
            this.store.applyChange(item);
          }
        }

        this.store.latestCursor = res.next_cursor;

        if (!res.has_more) {
          break;
        }
      }
    } catch (err) {
      console.error("[SyncEngine] Error polling new changes:", err.message);
    }
  }

  start() {
    if (this.isPolling) return;
    this.isPolling = true;

    // Run initial sync asynchronously, then start polling
    (async () => {
      try {
        await this.initialSync();
      } catch (err) {
        console.error("[SyncEngine] Fatal error during initial sync:", err);
      }

      // Schedule recurring polling
      const pollLoop = async () => {
        if (!this.isPolling) return;
        await this.pollNewChanges();
        if (this.isPolling) {
          this.timer = setTimeout(pollLoop, this.pollIntervalMs);
        }
      };

      this.timer = setTimeout(pollLoop, this.pollIntervalMs);
    })();
  }

  stop() {
    this.isPolling = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
