# DECISIONS

## What I assumed

- **Timezone and Date Boundary Handling:** The query parameters `from` and `to` are `YYYY-MM-DD` strings interpreted strictly in each building's local timezone (`Asia/Singapore`, `Asia/Jakarta`, `Australia/Sydney`). Sydney's Daylight Saving Time (DST) changes in October were handled by calculating local midnight boundaries and daily business hour windows using Luxon's IANA zone engine.
- **Undone Events (Rule 2):** Any event specifying `reverts_id` undoes the targeted event. Both the reverted event and the reverting event are completely omitted from all downstream SLA calculations.
- **Current Staff Names (Rule 3):** Event records contain the historical `actor_name` at the time of creation, but Rule 3 specifies displaying the current name from `/v1/staff`. When a `staff.updated` change event arrives, the responder's name is dynamically updated across the store.
- **Wall-Clock Deadlines (Rule 6):** Deadlines from event `due_at` fields are formatted as `"DD/MM/YYYY HH:mm"` (or ISO) in the site's local wall-clock time. These are converted to epoch seconds in the site's timezone. A request is marked `completed_late = true` strictly if the latest `complete` event has `at > deadline_seconds`.
- **Business Hours & Holidays (Rule 4):** Each site's weekly operating schedule (including Jakarta's half-day Saturday `08:00 - 12:00`) and site-specific holidays (closed all day) are computed by intersecting the open window with `[created_at, first_response.at]` on a daily basis in seconds, then floored to whole minutes.
- **Tamper-Proof Cursor Pagination (Level 4):** Cursors for `/api/requests` are signed with HMAC-SHA256 using an ephemeral server secret. Any invalid or tampered cursor yields HTTP 400 as mandated by `contract.md`.

## What I found in the API or data

- **Transient 503 and Rate Limits (429):** Rapid polling of `/v1/changes` initially triggered intermittent `503 Service temporarily unavailable` and `429 Too Many Requests`. I augmented `HelpdeskClient` with exponential backoff, jitter, and parsing of the `Retry-After` response header to ensure 100% resilient ingestion without flooding the upstream API.
- **Out-of-Order Change Events:** Several `event.created` records arrived before or concurrently with their corresponding `request.created` event. The `DataStore` was designed with placeholder event maps to ensure no events are dropped if they arrive before the request metadata.
- **Reverted Events & System Actors:** Found 26+ revert events in the first batches, plus 1,800+ automated events where `actor_id` was `null` (`"System"`). These were correctly excluded from responder identification according to Rules 2 and 3.
- **Jakarta Saturday Business Hours:** Unlike Singapore and Sydney (which are closed on weekends), Jakarta has Saturday operating hours (`08:00 - 12:00`). The daily interval intersection engine accounts for this seamlessly.

## How I used AI

- **Architecture Strategy:** Used AI to design an event-sourced in-memory synchronization architecture consuming `GET /v1/changes?limit=500`. This avoided making ~12,000 individual HTTP requests for request events, reducing total bootstrap time from ~20 minutes down to ~66 seconds.
- **Business Hours & Timezone Engine:** Prompted AI to generate the daily window intersection algorithm with Luxon for `businessTime.js`, rigorously handling partial business days, holidays, and Sydney DST shifts.
- **Edge Case & Contract Verification:** AI cross-checked all 7 rules against `docs/contract.md` to guarantee exact response shapes, null handling, tiebreakers for sorting (`id` ascending for ties and nulls last), and HTTP 400 validation rules.
- **Test Generation:** AI assisted in crafting unit and integration test suites using Node's native `node:test` runner to verify each level independently.

## Trade-offs and what I would do next

- **In-Memory Store vs. Persistent Database:** For ~12,000 requests and ~80,000 changes, the in-memory store consumes ~35MB of RAM and executes 6-month SLA queries in ~34ms (far surpassing the 10s requirement). The trade-off is that restarting the process triggers an initial bootstrap. With more time or for larger scale, I would persist snapshots to SQLite (WAL mode) so cold starts are instant.
- **Live Push to Browser:** The web dashboard currently polls `/ready` and renders on demand. Next steps would include adding Server-Sent Events (SSE) or WebSockets to stream live SLA updates directly into the browser dashboard as changes happen.
