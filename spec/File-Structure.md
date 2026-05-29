In Google Apps Script, all `.gs` files share a single, flat global namespace. Splitting code into multiple files does not create isolated modules or private scopes—it is purely an exercise in developer sanity, scannability, and organization.

Because files are loaded in alphabetical order by the runtime, any top-level global variables are initialized in that order. For this specific calendar sync project, a modular file layout keeps your configuration, core algorithms, and utility helpers distinct and easy to maintain.

Here is the recommended file architecture mapped directly to your task plan.

---

## Recommended File Structure

### 1. `Config.gs`

Keep this exclusively for human-editable configuration data. By isolating this file, you can modify sync paths or rules without touching a single line of operational code.

* **What goes here:** The `CALENDAR_CONFIG` array, target time bounds (e.g., `-7 days`), and global constants like your time safety threshold (`300000` ms).
* **Why:** If you use a tool like Git/GitHub via the Apps Script CLI (clasp), this file is easy to audit for configuration updates.

### 2. `Main.gs` (or `Code.gs`)

This is your orchestration layer and the entry point for your time-driven triggers.

* **What goes here:** The primary `orchestrateCalendarSync()` runner function, the `LockService` wrapper logic, execution clock initialization, and the outer `try...catch` loops that route to standard syncs or reconciliation passes.
* **Why:** When managing your triggers, you only ever need to point Google to this one file's primary function.

### 3. `SyncEngine.gs`

This is the heavy lifter. It should handle the API logic and state manipulation for the calendar feeds.

* **What goes here:** `processEventPayload()`, `executeReconciliationSync()`, token rotation routines, and structural parsing for master/exception recurring events.
* **Why:** Separating the API-dependent payload mapping from the rest of the project makes it much easier to debug when Google shifts or updates API behaviors.

### 4. `RuleEngine.gs`

Isolating your rule engine keeps text-mutation code from cluttering your API execution loops.

* **What goes here:** `evaluateRules(summary, rules)` and any future custom text-cleaning logic.
* **Why:** Since rules will expand as your calendar requirements change, you want a dedicated space to test regex boundaries without worrying about API calls.

### 5. `Utils.gs`

A clean home for low-level, deterministic logic transformations that don't care about calendar states.

* **What goes here:** `getDeterministicId()`, `generateMd5Hash()`, and streamlined wrapper helpers for reading/writing to the `PropertiesService`.

---

## 💡 Two Critical Apps Script Architecture Tips

Because of the flat namespace, keep these two quirks in mind as you begin implementing your task plan:

### 1. Avoid Top-Level Execution Side Effects

Since files execute alphabetically, if you declare a global variable in `Main.gs` that relies on a variable declared in `Utils.gs`, it may evaluate to `undefined` on startup.

* **The Fix:** Keep global variables strictly static (like your configuration object). For anything dynamic (like calculating the current timestamp or execution clock), evaluate it inside a function call at runtime.

### 2. Use a Pseudo-Namespace for Utilities

To ensure functions in `Utils.gs` don't accidentally collide with future global functions or built-in Apps Script keywords, consider grouping them inside a plain JavaScript object to act as a namespace:

```javascript
// In Utils.gs
const SyncUtils = {
  getDeterministicId: function(sourceId) {
    return "src" + sourceId.toLowerCase().replace(/[^a-v0-9]/g, "");
  },
  
  generateMd5Hash: function(text) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
    return digest.map(chr => (chr < 0 ? chr + 256 : chr).toString(16).padStart(2, '0')).join('');
  }
};

// Usage anywhere else in your project:
const safeId = SyncUtils.getDeterministicId(item.id);

```
