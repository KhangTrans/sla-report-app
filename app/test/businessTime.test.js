import test from "node:test";
import assert from "node:assert/strict";
import {
  isRequestCounted,
  filterUndoneEvents,
  parseLocalDeadline,
  calculateBusinessMinutes,
  evaluateRequestSLA,
  normalizeHolidayDate,
} from "../src/businessTime.js";

test("Rule 1: isRequestCounted filters requests properly", () => {
  const timezone = "Asia/Singapore";
  // Created at 2026-10-01 02:00:00 UTC -> 10:00:00 SGT (2026-10-01)
  const req1 = { id: 1, created_at: "2026-10-01T02:00:00Z", status: "complete" };
  assert.equal(isRequestCounted(req1, timezone, "2026-10-01", "2026-10-31"), true);
  assert.equal(isRequestCounted(req1, timezone, "2026-10-02", "2026-10-31"), false);

  // Status canceled should be skipped
  assert.equal(isRequestCounted({ ...req1, status: "canceled" }, timezone, "2026-10-01", "2026-10-31"), false);
  // deleted_at set should be skipped
  assert.equal(isRequestCounted({ ...req1, deleted_at: "2026-10-02T00:00:00Z" }, timezone, "2026-10-01", "2026-10-31"), false);
  // merged_into_id set should be skipped
  assert.equal(isRequestCounted({ ...req1, merged_into_id: 999 }, timezone, "2026-10-01", "2026-10-31"), false);
});

test("Rule 2: filterUndoneEvents removes reverting and reverted events", () => {
  const events = [
    { id: 1, status: "processing", at: 100, actor_id: 10 },
    { id: 2, status: "complete", at: 200, actor_id: 10 },
    { id: 3, status: "note", at: 300, reverts_id: 2 }, // Reverts event 2
    { id: 4, status: "complete", at: 400, actor_id: 10 },
  ];
  const filtered = filterUndoneEvents(events);
  // Both 2 and 3 should be absent
  assert.deepEqual(filtered.map((e) => e.id), [1, 4]);
});

test("Rule 4: calculateBusinessMinutes accurately calculates open hours", () => {
  const site = {
    timezone: "Asia/Singapore",
    business_hours: {
      mon: { open: "08:00", close: "18:00" },
      tue: { open: "08:00", close: "18:00" },
      wed: { open: "08:00", close: "18:00" },
      thu: { open: "08:00", close: "18:00" },
      fri: { open: "08:00", close: "18:00" },
      sat: null,
      sun: null,
    },
  };
  const holidays = new Set(["2026-10-06"]); // Tuesday is holiday

  // Monday 2026-10-05 08:30 SGT (00:30 UTC) to 09:12 SGT (01:12 UTC) -> 42 minutes
  const createdIso = "2026-10-05T00:30:00Z";
  // 01:12 UTC is 42 mins later = 42 * 60 = 2520 seconds later
  const startSec = 1791160200; // Monday 08:30 SGT
  const endSec = startSec + 42 * 60; // Monday 09:12 SGT
  const mins = calculateBusinessMinutes(site, holidays, "2026-10-05T00:30:00Z", endSec);
  assert.equal(mins, 42);

  // Response before created_at -> 0
  assert.equal(calculateBusinessMinutes(site, holidays, "2026-10-05T00:30:00Z", endSec - 100000), 0);
});

test("Rule 5 & 6 & 7: evaluateRequestSLA computes responder, targets, and deadlines", () => {
  const site = {
    id: 11,
    timezone: "Asia/Singapore",
    business_hours: {
      mon: { open: "08:00", close: "18:00" },
    },
  };
  const staff = new Map([[304, { id: 304, name: "Benjamin Tan" }]]);
  const holidays = new Set();

  const req = {
    id: 41210,
    site_id: 11,
    priority: "High",
    created_at: "2026-10-05T00:30:00Z",
  };

  const events = [
    { id: 1, status: "pending", at: 1791160200, actor_id: null }, // System
    { id: 2, status: "processing", at: 1791160200 + 42 * 60, actor_id: 304, actor_name: "Ben", due_at: "05/10/2026 17:00" },
    { id: 3, status: "complete", at: 1791160200 + 60 * 60, actor_id: 304 },
  ];

  const res = evaluateRequestSLA(req, events, site, holidays, staff);
  assert.equal(res.id, 41210);
  assert.equal(res.site_id, 11);
  assert.equal(res.responder_id, 304);
  assert.equal(res.responder, "Benjamin Tan"); // current name from staff
  assert.equal(res.response_business_minutes, 42);
  assert.equal(res.within_target, true); // High target is <= 60
  assert.equal(res.completed_late, false); // Completed at 09:30 SGT, deadline was 17:00 SGT
});
