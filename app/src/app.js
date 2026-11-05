import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { DataStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(str) {
  if (typeof str !== "string" || !DATE_REGEX.test(str)) return false;
  const dt = DateTime.fromISO(str);
  return dt.isValid && dt.toISODate() === str;
}

export function createApp({ store = new DataStore(), syncEngine = null } = {}) {
  const app = express();

  app.use(express.static(path.join(here, "..", "public")));

  // GET /health: 200 {"ok": true} as soon as the app is up.
  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  // GET /ready: 200 {"ready": true} once the app can answer reports for the last six months, 503 until then.
  app.get("/ready", (req, res) => {
    if (store.isReady) {
      res.json({ ready: true });
    } else {
      res.status(503).json({ ready: false });
    }
  });

  // GET /api/sla-report?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get("/api/sla-report", (req, res) => {
    if (!store.isReady) {
      return res.status(503).json({ error: "Service still synchronizing initial data" });
    }

    const { from, to } = req.query;

    if (!isValidDateString(from) || !isValidDateString(to) || from > to) {
      return res.status(400).json({
        error: "Missing or invalid 'from' or 'to' date parameters (expected YYYY-MM-DD, from <= to)",
      });
    }

    try {
      const report = store.getReport(from, to);
      return res.json(report);
    } catch (err) {
      console.error("[SLA Report] Error generating report:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/requests (level 4)
  app.get("/api/requests", (req, res) => {
    if (!store.isReady) {
      return res.status(503).json({ error: "Service still synchronizing initial data" });
    }

    const { from, to, site_id, responder_id, late, within_target, sort = "id", limit = "50", cursor } = req.query;

    if (!isValidDateString(from) || !isValidDateString(to) || from > to) {
      return res.status(400).json({
        error: "Missing or invalid 'from' or 'to' date parameters (expected YYYY-MM-DD, from <= to)",
      });
    }

    let siteIdNum = undefined;
    if (site_id !== undefined) {
      siteIdNum = Number(site_id);
      if (!Number.isInteger(siteIdNum)) {
        return res.status(400).json({ error: "Invalid 'site_id' parameter, expected integer" });
      }
    }

    let responderIdNum = undefined;
    if (responder_id !== undefined) {
      responderIdNum = Number(responder_id);
      if (!Number.isInteger(responderIdNum)) {
        return res.status(400).json({ error: "Invalid 'responder_id' parameter, expected integer" });
      }
    }

    let lateVal = undefined;
    if (late !== undefined) {
      if (late !== "true" && late !== "false") {
        return res.status(400).json({ error: "Invalid 'late' parameter, expected 'true' or 'false'" });
      }
      lateVal = late === "true";
    }

    let withinTargetVal = undefined;
    if (within_target !== undefined) {
      if (within_target !== "true" && within_target !== "false") {
        return res.status(400).json({ error: "Invalid 'within_target' parameter, expected 'true' or 'false'" });
      }
      withinTargetVal = within_target === "true";
    }

    const ALLOWED_SORTS = ["id", "-id", "response_business_minutes", "-response_business_minutes"];
    if (!ALLOWED_SORTS.includes(sort)) {
      return res.status(400).json({
        error: `Invalid 'sort' parameter, expected one of: ${ALLOWED_SORTS.join(", ")}`,
      });
    }

    const limitNum = Number(limit);
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 200) {
      return res.status(400).json({ error: "Invalid 'limit' parameter, expected integer between 1 and 200" });
    }

    try {
      const result = store.browseRequests({
        from,
        to,
        site_id: siteIdNum,
        responder_id: responderIdNum,
        late: lateVal,
        within_target: withinTargetVal,
        sort,
        limit: limitNum,
        cursor,
      });

      return res.json(result);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      console.error("[Browse Requests] Error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
