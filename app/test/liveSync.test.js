import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../src/store.js";
import { SyncEngine } from "../src/sync.js";

test("Level 3 Live Sync: new changes in feed are reflected in store immediately", async () => {
  const store = new DataStore();
  store.setSites([
    {
      id: 11,
      name: "Singapore Tower",
      timezone: "Asia/Singapore",
      business_hours: {
        mon: { open: "08:00", close: "18:00" },
      },
    },
  ]);
  store.setStaff([{ id: 304, name: "Benjamin Tan" }]);
  store.setHolidays(11, []);
  store.isReady = true;

  // Mock client that returns a new request change
  let changeCount = 0;
  const mockClient = {
    async get(path) {
      if (path === "/v1/changes") {
        if (changeCount === 0) {
          changeCount++;
          return {
            data: [
              {
                seq: 1,
                type: "request.created",
                request: {
                  id: 99999,
                  site_id: 11,
                  priority: "High",
                  status: "complete",
                  created_at: "2026-10-05T01:00:00Z",
                  deleted_at: null,
                  merged_into_id: null,
                },
              },
            ],
            next_cursor: "cursor-1",
            has_more: false,
          };
        }
        return { data: [], next_cursor: "cursor-1", has_more: false };
      }
      return { data: [] };
    },
  };

  const sync = new SyncEngine({ client: mockClient, store, pollIntervalMs: 50 });
  await sync.pollNewChanges();

  // Verify that request 99999 is now in the report
  const report = store.getReport("2026-10-01", "2026-10-31");
  assert.equal(report.requests.some((r) => r.id === 99999), true);
});
