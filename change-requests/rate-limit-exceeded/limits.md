Based on our discussion, here are the specific limits applicable to a **free (`gmail.com`) account**:

* **Google Calendar API Rate Limit:** 600 requests per minute, per user (subject to stricter, aggressive throttling on sequential writes/deletions to a single calendar).
* **Apps Script Execution Runtime Limit:** Maximum **6 minutes** per single execution.
* **Apps Script Daily Trigger Runtime Limit:** Maximum **60 minutes** of total cumulative runtime per day for all time-driven triggers.
* **Apps Script Daily Calendar Creation Limit:** Maximum **5,000 calendar events** created per day.
* **Apps Script Concurrency Limit:** Maximum **30 simultaneous executions** running at the same time per script.

Note on batching:

Yes. The Google Calendar API supports a feature called **Batch Requests**, which allows you to bundle up to **500 individual API calls** (such as insertions, updates, or deletions) into a single HTTP request.

However, there is a critical caveat regarding how this interacts with the rate limits you are hitting in Google Apps Script.

---

## How Batching Works (and Its Limits)

* **Single HTTP Connection:** Instead of making 50 independent network calls to delete 50 events, your script sends one `POST` request to a `/batch` endpoint containing all 50 operations.
* **Quota Consumption:** **Batching does not bypass rate limits.** Google treats every single operation inside the batch as an individual request against your quota. If you send a batch of 100 deletions, it immediately counts as 100 requests toward your 600 requests-per-minute limit and will still trigger single-calendar structural throttling if processed too quickly by the backend.

---

## Implementation in Google Apps Script

Apps Script does not natively batch requests automatically when using the standard `Calendar` Advanced Service. To use batching, you must construct a multipart HTTP request manually using `UrlFetchApp`, or use a community utility library.

Given your `SyncEngine.gs` architecture, implementing raw multipart batching requires significant boilerplate code.

### Recommended Strategy

Because batching still triggers the same server-side burst limits on a single calendar, the standard engineering path for a synchronization engine is to stick with individual sequential calls but strictly manage the pacing using the **Exponential Backoff** pattern previously discussed.

If you do decide to implement batching to reduce network overhead, you must still restrict the batch size to small clusters (e.g., 20–30 operations per batch) and place a `Utilities.sleep()` delay between each batch submission to keep the backend from throttling the execution.
