The error in your log (`API call to calendar.events.delete failed with error: Rate Limit Exceeded`) points directly to the rate limits of the **Google Calendar API**, rather than standard Google Apps Script daily quotas.

There are three distinct layers of limits causing this behavior when your `SyncEngine` script processes data rapidly:

## 1. Rate-Per-Minute Quotas (The Direct Cause)

The Calendar API enforces short-term pacing limits via a sliding 60-second window:

* **Per user per project:** **600 requests per minute**.
* If your script loops over calendar entries and fires off numerous deletions or insertions sequentially without a pause, you will easily hit this ceiling in a few seconds.

## 2. Burst / Operational Limits

Google applies undocumented, dynamic concurrency limits to protect its backend. If you execute rapid, sequential modifications (especially `delete` or `update` operations) on a **single specific calendar**, Google will throttle the requests even if you are well under the 600-request-per-minute threshold.

## 3. Daily Apps Script Quotas (Long-term)

While this didn't cause your immediate error, your sync script is also bound by daily totals:

* **Calendar events created:** 5,000/day for standard consumer accounts (`gmail.com`) or 10,000/day for Google Workspace accounts.

---

## How to Fix It in Your Code

To stop the execution from crashing on dense sync intervals, you need to handle pacing and backoff inside `SyncEngine.gs` (specifically around line 26 where `processSyncItem` is called):

### Mitigation A: Add Pacing Delays

If you know a sync run handles a high volume of items, add a small, fixed delay inside your loop to stay under the per-minute burst thresholds.

```javascript
// Add a short sleep (e.g., 500ms to 1s) between continuous write/delete calls
Utilities.sleep(500); 

```

### Mitigation B: Implement Exponential Backoff

Wrap your `calendar.events.delete` or `Calendar.Events.remove` call in a try/catch block that waits and retries when it encounters a rate limit error.

```javascript
function safeDeleteEvent(calendarId, eventId) {
  var maxRetries = 4;
  var status = false;
  
  for (var n = 0; n < maxRetries; n++) {
    try {
      Calendar.Events.remove(calendarId, eventId);
      status = true;
      break;
    } catch (err) {
      // Check if the error message contains a rate limit or 429/403 status
      if (err.message.indexOf('Rate Limit Exceeded') !== -1 || err.message.indexOf('User Rate Limit Exceeded') !== -1) {
        // Exponential backoff: 1s, 2s, 4s, 8s + random variation
        var delay = Math.pow(2, n) * 1000 + Math.round(Math.random() * 1000);
        Logger.log('Rate limit hit. Retrying in ' + delay + 'ms...');
        Utilities.sleep(delay);
      } else {
        throw err; // Re-throw if it's a different error (e.g., 404 Not Found)
      }
    }
  }
  return status;
}

```

Unlike standard quotas, Google does not publish the exact numerical values for its burst and operational limits. These are dynamic, server-side protection mechanisms designed to prevent infrastructure abuse and traffic spikes on individual resources.

For your specific setup, these limits manifest as three distinct hidden boundaries:

### 1. The Single-Calendar Concurrent Write Limit

While the project-wide limit allows up to 600 requests per minute across *all* calendars, Google restricts the volume of rapid modifications made to a **single specific calendar ID**.

* **The behavior:** If your script attempts to delete or insert dozens of events into `TEST CALENDAR` in a rapid, unthrottled sequence, the API triggers a `Rate Limit Exceeded` or `403 User Rate Limit Exceeded` error long before you hit the 600-request total.

### 2. Identical Operation API Throttling

Google monitors the *type* of request being made. Sequential `calendar.events.delete` or `calendar.events.patch` calls are throttled much more aggressively than sequential `calendar.events.get` (read) calls. This is designed to prevent runaway scripts from accidentally wiping out large amounts of user data or overwhelming the database backend with write locks.

### 3. Sync Token Expiration and Rate Matching

When using incremental syncs with sync tokens, making structural changes to the calendar (like bulk deletions) while simultaneously fetching updates can cause the internal state to fall out of sync. Google occasionally drops the connection or enforces a temporary backoff window to force the client script to pause and refresh its state.

---

## The Handling Standard

Because these limits are dynamic and depend on current server load, the architecture standard for handling them relies entirely on **client-side pacing**. You cannot avoid them purely by counting requests; your code must expect them to happen and react programmatically:

1. **Enforce Artificial Latency:** Introduce a mandatory pause (`Utilities.sleep(500)`) between destructive API operations to mimic human interaction speeds.
2. **Catch and Retry:** Wrap individual API mutations in a `try/catch` loop that intercepts the error string, calculates an increasing delay based on exponential backoff, and retries the specific failed item rather than letting the entire orchestration crash.
