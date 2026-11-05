import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { DataStore } from "../src/store.js";

function setupMockStore() {
  const store = new DataStore();
  store.setSites([
    {
      id: 11,
      name: "Singapore Tower",
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
    },
  ]);
  store.setStaff([
    { id: 304, name: "Benjamin Tan" },
    { id: 305, name: "Chloe Lim" },
  ]);
  store.setHolidays(11, []);

  // Add Request 1: 2026-10-05 08:30 SGT, responded in 42 mins, completed on time
  store.applyChange({
    type: "request.created",
    request: {
      id: 41210,
      site_id: 11,
      priority: "High",
      status: "complete",
      created_at: "2026-10-05T00:30:00Z", // 08:30 SGT
      deleted_at: null,
      merged_into_id: null,
    },
  });
  store.applyChange({
    type: "event.created",
    request_id: 41210,
    event: {
      id: 101,
      status: "processing",
      at: 1791160200 + 42 * 60, // +42 mins
      actor_id: 304,
      actor_name: "Ben",
      due_at: "05/10/2026 17:00",
    },
  });
  store.applyChange({
    type: "event.created",
    request_id: 41210,
    event: {
      id: 102,
      status: "complete",
      at: 1791160200 + 60 * 60, // completed before 17:00
      actor_id: 304,
    },
  });

  // Add Request 2: unresponded
  store.applyChange({
    type: "request.created",
    request: {
      id: 41214,
      site_id: 11,
      priority: "Low",
      status: "pending",
      created_at: "2026-10-05T01:00:00Z",
      deleted_at: null,
      merged_into_id: null,
    },
  });

  store.isReady = true;
  return store;
}

test("GET /ready returns 503 when not ready, 200 when ready", async () => {
  const store = new DataStore();
  const app = createApp({ store });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    let res = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ready: false });

    store.isReady = true;
    res = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ready: true });
  } finally {
    server.close();
  }
});

test("GET /api/sla-report validates query parameters", async () => {
  const store = setupMockStore();
  const app = createApp({ store });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    // Missing params -> 400
    let res = await fetch(`http://127.0.0.1:${port}/api/sla-report`);
    assert.equal(res.status, 400);

    // Invalid date format -> 400
    res = await fetch(`http://127.0.0.1:${port}/api/sla-report?from=invalid&to=2026-10-31`);
    assert.equal(res.status, 400);

    // from > to -> 400
    res = await fetch(`http://127.0.0.1:${port}/api/sla-report?from=2026-10-31&to=2026-10-01`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("GET /api/sla-report returns expected structure and metrics", async () => {
  const store = setupMockStore();
  const app = createApp({ store });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/sla-report?from=2026-10-01&to=2026-10-31`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.from, "2026-10-01");
    assert.equal(body.to, "2026-10-31");
    assert.equal(body.requests.length, 2);

    const r1 = body.requests.find((r) => r.id === 41210);
    assert.deepEqual(r1, {
      id: 41210,
      site_id: 11,
      responder_id: 304,
      responder: "Benjamin Tan",
      response_business_minutes: 42,
      within_target: true,
      completed_late: false,
    });

    const r2 = body.requests.find((r) => r.id === 41214);
    assert.deepEqual(r2, {
      id: 41214,
      site_id: 11,
      responder_id: null,
      responder: null,
      response_business_minutes: null,
      within_target: null,
      completed_late: null,
    });

    assert.equal(body.responders.length, 1);
    assert.deepEqual(body.responders[0], {
      id: 304,
      name: "Benjamin Tan",
      requests: 1,
      within_target: 1,
      completed_late: 0,
    });
  } finally {
    server.close();
  }
});

test("GET /api/requests (Level 4) filters, sorts, and paginates with cursor", async () => {
  const store = setupMockStore();
  const app = createApp({ store });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();

    // Bad params
    let res = await fetch(`http://127.0.0.1:${port}/api/requests?from=2026-10-01&to=2026-10-31&sort=invalid`);
    assert.equal(res.status, 400);

    res = await fetch(`http://127.0.0.1:${port}/api/requests?from=2026-10-01&to=2026-10-31&cursor=tampered`);
    assert.equal(res.status, 400);

    // Limit 1 pagination test
    res = await fetch(`http://127.0.0.1:${port}/api/requests?from=2026-10-01&to=2026-10-31&limit=1&sort=id`);
    assert.equal(res.status, 200);
    let json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 41210);
    assert.notEqual(json.next_cursor, null);

    // Fetch page 2 using next_cursor
    res = await fetch(`http://127.0.0.1:${port}/api/requests?from=2026-10-01&to=2026-10-31&limit=1&sort=id&cursor=${json.next_cursor}`);
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 41214);
    assert.equal(json.next_cursor, null); // Last page
  } finally {
    server.close();
  }
});
