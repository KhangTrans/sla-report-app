import { DateTime } from "luxon";

const DAY_NAMES = ["", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Parses date string in DD/MM/YYYY into YYYY-MM-DD
 */
export function normalizeHolidayDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    const [d, m, y] = parts;
    return `${y.padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return dateStr;
}

/**
 * Rule 1: Checks if request counts for the given date range [from, to] (inclusive).
 * Dates are compared in the site's local timezone.
 * Skips canceled, deleted_at, merged_into_id.
 */
export function isRequestCounted(request, siteTimezone, fromDateStr, toDateStr) {
  if (!request) return false;
  if (request.status === "canceled") return false;
  if (request.deleted_at != null) return false;
  if (request.merged_into_id != null) return false;

  if (!request.created_at) return false;

  const dt = DateTime.fromISO(request.created_at, { zone: siteTimezone });
  if (!dt.isValid) return false;

  const localDate = dt.toISODate(); // YYYY-MM-DD
  return localDate >= fromDateStr && localDate <= toDateStr;
}

/**
 * Rule 2: Undone events.
 * An event with reverts_id undoes the event it points at.
 * Both the reverted event and the reverting event are ignored.
 */
export function filterUndoneEvents(events) {
  if (!events || events.length === 0) return [];

  const revertedIds = new Set();
  for (const e of events) {
    if (e.reverts_id != null) {
      revertedIds.add(e.reverts_id);
    }
  }

  return events.filter((e) => e.reverts_id == null && !revertedIds.has(e.id));
}

/**
 * Parses site-local wall-clock deadline into Unix seconds.
 * Handles "DD/MM/YYYY HH:mm" or ISO format.
 */
export function parseLocalDeadline(dueAtStr, timezone) {
  if (!dueAtStr || typeof dueAtStr !== "string") return null;

  const trimmed = dueAtStr.trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mon, y, h = "0", min = "0", s = "0"] = m;
    const dt = DateTime.fromObject(
      {
        year: parseInt(y, 10),
        month: parseInt(mon, 10),
        day: parseInt(d, 10),
        hour: parseInt(h, 10),
        minute: parseInt(min, 10),
        second: parseInt(s, 10),
        millisecond: 0,
      },
      { zone: timezone }
    );
    return dt.isValid ? dt.toSeconds() : null;
  }

  const isoDt = DateTime.fromISO(trimmed, { zone: timezone });
  if (isoDt.isValid) return isoDt.toSeconds();

  return null;
}

/**
 * Rule 4: Response minutes.
 * Business-hours time from created_at to first response's at,
 * using site's business_hours and holidays, summed in seconds, then floored to minutes.
 * Returns 0 if first response is earlier than created_at.
 */
export function calculateBusinessMinutes(site, holidaysSet, createdAtIso, responseAtSeconds) {
  if (!site || !createdAtIso || responseAtSeconds == null) return null;

  const startDt = DateTime.fromISO(createdAtIso, { zone: site.timezone });
  if (!startDt.isValid) return null;

  const tStart = startDt.toSeconds();
  const tEnd = Number(responseAtSeconds);

  if (tEnd <= tStart) {
    return 0;
  }

  const endDt = DateTime.fromSeconds(tEnd, { zone: site.timezone });
  let curDay = startDt.startOf("day");
  const lastDay = endDt.startOf("day");

  let totalBusinessSeconds = 0;

  while (curDay <= lastDay) {
    const dayIso = curDay.toISODate(); // YYYY-MM-DD
    // If it's a holiday, closed all day
    if (!holidaysSet.has(dayIso)) {
      const dayName = DAY_NAMES[curDay.weekday];
      const hours = site.business_hours?.[dayName];

      if (hours && hours.open && hours.close) {
        const [openH, openM] = hours.open.split(":").map(Number);
        const [closeH, closeM] = hours.close.split(":").map(Number);

        const openDt = curDay.set({ hour: openH, minute: openM, second: 0, millisecond: 0 });
        const closeDt = curDay.set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 });

        const openSec = openDt.toSeconds();
        const closeSec = closeDt.toSeconds();

        if (closeSec > openSec) {
          const segStart = Math.max(openSec, tStart);
          const segEnd = Math.min(closeSec, tEnd);
          if (segEnd > segStart) {
            totalBusinessSeconds += segEnd - segStart;
          }
        }
      }
    }

    curDay = curDay.plus({ days: 1 }).startOf("day");
  }

  return Math.floor(totalBusinessSeconds / 60);
}

/**
 * Evaluates rules 3 to 7 for a single request.
 */
export function evaluateRequestSLA(request, rawEvents, site, holidaysSet, staffMap) {
  const validEvents = filterUndoneEvents(rawEvents);

  // Rule 3: First response and responder
  // Earliest event (by at) with status "processing" and an actor_id
  const processingEvents = validEvents.filter(
    (e) => e.status === "processing" && e.actor_id != null
  );

  let firstResponse = null;
  if (processingEvents.length > 0) {
    // Sort earliest by at, ties by id
    processingEvents.sort((a, b) => a.at - b.at || a.id - b.id);
    firstResponse = processingEvents[0];
  }

  let responder_id = null;
  let responder = null;
  let response_business_minutes = null;
  let within_target = null;

  if (firstResponse) {
    responder_id = firstResponse.actor_id;
    responder = staffMap.get(responder_id)?.name ?? firstResponse.actor_name ?? null;

    // Rule 4: Response minutes
    response_business_minutes = calculateBusinessMinutes(
      site,
      holidaysSet,
      request.created_at,
      firstResponse.at
    );

    // Rule 5: Within target
    // <= 60 for High, 240 for Medium, 480 for Low or null priority
    let target = 480;
    if (request.priority === "High") target = 60;
    else if (request.priority === "Medium") target = 240;
    else if (request.priority === "Low" || request.priority == null) target = 480;

    within_target = response_business_minutes <= target;
  }

  // Rule 6: Completed late
  // The last event with status complete (by at) has at strictly after the deadline.
  // The deadline is due_at of the latest event that has one (by at), read as site-local wall-clock time.
  const completeEvents = validEvents.filter((e) => e.status === "complete");
  let completed_late = null;

  if (completeEvents.length > 0) {
    completeEvents.sort((a, b) => a.at - b.at || a.id - b.id);
    const lastComplete = completeEvents[completeEvents.length - 1];

    const dueEvents = validEvents.filter((e) => e.due_at != null && e.due_at !== "");
    if (dueEvents.length > 0) {
      dueEvents.sort((a, b) => a.at - b.at || a.id - b.id);
      const latestDueEvent = dueEvents[dueEvents.length - 1];
      const deadlineSec = parseLocalDeadline(latestDueEvent.due_at, site.timezone);

      if (deadlineSec != null) {
        completed_late = lastComplete.at > deadlineSec;
      }
    }
  }

  return {
    id: request.id,
    site_id: request.site_id,
    responder_id,
    responder,
    response_business_minutes,
    within_target,
    completed_late,
  };
}
