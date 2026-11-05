import crypto from "node:crypto";
import { DateTime } from "luxon";
import {
  evaluateRequestSLA,
  isRequestCounted,
  normalizeHolidayDate,
} from "./businessTime.js";

// Secret for HMAC cursor signing, unique per server process
const CURSOR_SECRET = crypto.randomBytes(32).toString("hex");

export class DataStore {
  constructor() {
    this.sites = new Map(); // site_id -> site
    this.holidays = new Map(); // site_id -> Set of 'YYYY-MM-DD'
    this.staff = new Map(); // staff_id -> { id, name }
    this.statuses = new Map(); // value -> label
    this.requests = new Map(); // request_id -> request
    this.events = new Map(); // request_id -> Map<event_id, event>
    this.slaCache = new Map(); // request_id -> slaResult
    this.isReady = false;
    this.latestCursor = null;
  }

  setSites(sitesList) {
    for (const site of sitesList) {
      this.sites.set(site.id, site);
    }
  }

  setHolidays(siteId, holidaysList) {
    const set = new Set();
    for (const h of holidaysList) {
      const normalized = normalizeHolidayDate(h.date);
      if (normalized) set.add(normalized);
    }
    this.holidays.set(siteId, set);
  }

  setStaff(staffList) {
    for (const s of staffList) {
      this.staff.set(s.id, s);
    }
  }

  updateStaffMember(staffMember) {
    if (!staffMember || staffMember.id == null) return;
    this.staff.set(staffMember.id, staffMember);

    // Update any cached SLA responders with this updated name
    for (const [reqId, sla] of this.slaCache.entries()) {
      if (sla.responder_id === staffMember.id) {
        sla.responder = staffMember.name;
      }
    }
  }

  setStatuses(statusesList) {
    for (const s of statusesList) {
      this.statuses.set(s.value, s.label);
    }
  }

  computeSiteLocalDate(request) {
    const site = this.sites.get(request.site_id);
    if (!site || !request.created_at) return null;
    const dt = DateTime.fromISO(request.created_at, { zone: site.timezone });
    return dt.isValid ? dt.toISODate() : null;
  }

  recomputeSLA(requestId) {
    const req = this.requests.get(requestId);
    if (!req) return null;

    if (req.status === "canceled" || req.deleted_at != null || req.merged_into_id != null) {
      this.slaCache.delete(requestId);
      return null;
    }

    const site = this.sites.get(req.site_id);
    if (!site) return null;

    const holidaysSet = this.holidays.get(req.site_id) || new Set();
    const eventsMap = this.events.get(requestId);
    const rawEvents = eventsMap ? Array.from(eventsMap.values()) : [];

    const sla = evaluateRequestSLA(req, rawEvents, site, holidaysSet, this.staff);
    this.slaCache.set(requestId, sla);
    return sla;
  }

  applyChange(change) {
    if (!change || !change.type) return;

    if (change.type === "request.created" || change.type === "request.updated") {
      const req = change.request;
      if (!req || req.id == null) return;

      req.siteLocalDate = this.computeSiteLocalDate(req);
      this.requests.set(req.id, req);
      this.recomputeSLA(req.id);
    } else if (change.type === "event.created") {
      const reqId = change.request_id;
      const event = change.event;
      if (reqId == null || !event || event.id == null) return;

      let eventMap = this.events.get(reqId);
      if (!eventMap) {
        eventMap = new Map();
        this.events.set(reqId, eventMap);
      }
      eventMap.set(event.id, event);

      if (this.requests.has(reqId)) {
        this.recomputeSLA(reqId);
      }
    } else if (change.type === "staff.updated") {
      this.updateStaffMember(change.staff);
    }
  }

  getReport(from, to) {
    const requests = [];
    const respondersMap = new Map();

    for (const req of this.requests.values()) {
      if (req.status === "canceled" || req.deleted_at != null || req.merged_into_id != null) {
        continue;
      }

      const siteDate = req.siteLocalDate;
      if (!siteDate || siteDate < from || siteDate > to) {
        continue;
      }

      let sla = this.slaCache.get(req.id);
      if (!sla) {
        sla = this.recomputeSLA(req.id);
      }
      if (!sla) continue;

      requests.push(sla);

      // Aggregate responders
      if (sla.responder_id != null) {
        let stats = respondersMap.get(sla.responder_id);
        if (!stats) {
          stats = {
            id: sla.responder_id,
            name: this.staff.get(sla.responder_id)?.name ?? sla.responder ?? "",
            requests: 0,
            within_target: 0,
            completed_late: 0,
          };
          respondersMap.set(sla.responder_id, stats);
        }
        stats.requests++;
        if (sla.within_target === true) stats.within_target++;
        if (sla.completed_late === true) stats.completed_late++;
      }
    }

    // Sort responders by name or id for stable output
    const responders = Array.from(respondersMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name) || a.id - b.id
    );

    return {
      from,
      to,
      requests,
      responders,
    };
  }

  // Level 4: Cursor-based request browsing
  generateCursor(payload) {
    const json = JSON.stringify(payload);
    const hmac = crypto.createHmac("sha256", CURSOR_SECRET).update(json).digest("hex");
    return Buffer.from(JSON.stringify({ p: payload, s: hmac })).toString("base64url");
  }

  parseCursor(cursorStr) {
    if (!cursorStr) return null;
    try {
      const decoded = Buffer.from(cursorStr, "base64url").toString("utf8");
      const { p, s } = JSON.parse(decoded);
      const expectedHmac = crypto.createHmac("sha256", CURSOR_SECRET).update(JSON.stringify(p)).digest("hex");
      if (s !== expectedHmac) {
        throw new Error("Invalid cursor signature");
      }
      return p;
    } catch {
      const err = new Error("Invalid cursor");
      err.status = 400;
      throw err;
    }
  }

  browseRequests({
    from,
    to,
    site_id,
    responder_id,
    late,
    within_target,
    sort = "id",
    limit = 50,
    cursor,
  }) {
    // 1. Gather all candidate rows matching date range
    const matchingRows = [];

    for (const req of this.requests.values()) {
      if (req.status === "canceled" || req.deleted_at != null || req.merged_into_id != null) {
        continue;
      }

      const siteDate = req.siteLocalDate;
      if (!siteDate || siteDate < from || siteDate > to) {
        continue;
      }

      let sla = this.slaCache.get(req.id);
      if (!sla) {
        sla = this.recomputeSLA(req.id);
      }
      if (!sla) continue;

      // Filter: site_id
      if (site_id !== undefined && sla.site_id !== site_id) {
        continue;
      }

      // Filter: responder_id
      if (responder_id !== undefined && sla.responder_id !== responder_id) {
        continue;
      }

      // Filter: late (completed_late)
      if (late !== undefined && sla.completed_late !== late) {
        continue;
      }

      // Filter: within_target
      if (within_target !== undefined && sla.within_target !== within_target) {
        continue;
      }

      matchingRows.push(sla);
    }

    // 2. Sort according to contract:
    // id (default), -id, response_business_minutes, -response_business_minutes. Nulls last; ties by id ascending
    matchingRows.sort((a, b) => {
      if (sort === "id") {
        return a.id - b.id;
      }
      if (sort === "-id") {
        return b.id - a.id;
      }
      if (sort === "response_business_minutes") {
        const valA = a.response_business_minutes;
        const valB = b.response_business_minutes;
        if (valA === valB) return a.id - b.id;
        if (valA === null) return 1; // Nulls last
        if (valB === null) return -1;
        return valA - valB || a.id - b.id;
      }
      if (sort === "-response_business_minutes") {
        const valA = a.response_business_minutes;
        const valB = b.response_business_minutes;
        if (valA === valB) return a.id - b.id;
        if (valA === null) return 1; // Nulls last
        if (valB === null) return -1;
        return valB - valA || a.id - b.id;
      }
      return a.id - b.id;
    });

    // 3. Keyset / offset pagination with cursor
    let startIndex = 0;
    if (cursor) {
      const parsed = this.parseCursor(cursor);
      if (parsed && typeof parsed.offset === "number") {
        startIndex = parsed.offset;
      } else {
        const err = new Error("Invalid cursor payload");
        err.status = 400;
        throw err;
      }
    }

    const pageData = matchingRows.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + pageData.length;
    const hasNext = nextOffset < matchingRows.length;
    const next_cursor = hasNext ? this.generateCursor({ offset: nextOffset }) : null;

    return {
      data: pageData,
      next_cursor,
    };
  }
}
