// vim: set ft=javascript ts=2 sw=2 et:
//
// Management of app config and state

// UserProperties :=
//   { syncToken: '{"srcA::dstA":"token1", "srcB::dstA":"token2", ...}, ... }'
//   { configHash: '{"srcA::dstA":"hash1", "srcB::dstA":"hash2", ...}, ... }'
//   { syncTime: '{"srcA::dstA":1712345678901, ...}, ... }'

class ScriptProperties {
  // Not supported in Google Apps Script; see after class
  // static GasUserProperties = null;
  // static ConfigPairStateKey = ['syncToken', ...];

  constructor(props) {
    Object.assign(this, props);
  }

  allKeys() {
    return new Set(ScriptProperties.ConfigPairStateKeys.flatMap( attr => Object.keys(this[attr] ?? {}) ));
  }

  clear(key) {
    for (const k of ScriptProperties.ConfigPairStateKeys) {
      if (this[k]) { delete this[k][key]; }
    }
  }

  update(key, kvObj) {
    for (const attr of ScriptProperties.ConfigPairStateKeys) {
      if (attr in kvObj) {
        if (!this[attr]) { this[attr] = {}; }
        if (kvObj[attr] != null) {
          this[attr][key] = kvObj[attr];
        } else {
          delete this[attr][key];
        }
      }
    }
  }

  static load() {
    if (!ScriptProperties.GasUserProperties) {
      ScriptProperties.GasUserProperties = PropertiesService.getUserProperties();
    }
    const props = ScriptProperties.GasUserProperties.getProperties();
    for (const a of ScriptProperties.ConfigPairStateKeys) {
      if (!props[a]) { props[a] = '{}'; }
      props[a] = JSON.parse(props[a]); // XXX try {} catch {}
    }

    return new ScriptProperties(props);
  }

  static store(props) {
    for (const a of ScriptProperties.ConfigPairStateKeys) {
      props[a] = JSON.stringify(props[a] || {});
    }
    ScriptProperties.GasUserProperties.setProperties(props);
  }

}

ScriptProperties.GasUserProperties = null;
ScriptProperties.ConfigPairStateKeys = ['syncToken', 'configHash', 'syncTime'];

/**
 * Turn CALENDAR_CONFIG and the stored script properties into Active (sync)
 * configs, the state keys still remembered within the reclaim window, and the
 * stale state keys to dismiss.
 *
 * Config:
 * Any entry whose source calendar reference resolves to ONE calendar ID and
 * whose destination calendar reference resolves to ONE different calendar ID
 * is an ActiveConfig. A reference may be a calendar ID or a display name —
 * either a calendar's `summary` or its `summaryOverride`. Entries that resolve
 * to the same (srcId, dstId) pair are duplicates: all of them are skipped and
 * a warning is logged.
 *
 * All others are skipped with a warning: unresolvable (zero IDs found),
 * ambiguous (2+ IDs found), or absurd (srcId == dstId).
 *
 * Resolution only loads calendars the config references (by name or ID) or
 * that stored state keys reference (by ID) — never the user's full calendar
 * list.
 *
 * State:
 *   If srcId::dstId matches an Active config, keep - processing will update
 *   All other stored state is held for STATE_RECLAIM_DAYS after its last
 *   successful sync (props.syncTime), giving time to fix a renamed or re-added
 *   calendar. Keys still within the window are returned as remembered. After
 *   that the pair's state is dismissed (state cleared; synced replicas are
 *   left untouched and reconciled on a future full sync). Keys with no
 *   recorded syncTime are dismissed immediately.
 *
 * @return {[ActiveConfig[], string[], string[]]} [active configs,
 *         remembered state keys (within reclaim window), stale keys to dismiss]
 */
function qualifyConfig(props) {
  const active = [];
  const remembered = [];
  const stale = [];

  // Only calendars the config references (by name or ID) or that remembered
  // state keys reference (by ID) are loaded — the maps below are bounded by
  // CALENDAR_CONFIG and the state keys, not by every calendar the user can see.
  const calReferences = new Set(CALENDAR_CONFIG.flatMap(cc => [cc.source, cc.destination]));
  const stateKeys = props.allKeys(); // Set of keys like 'srcId::dstId'
  stateKeys.forEach(key => key.split('::').forEach(id => calReferences.add(id)));

  const calId2Name = new Map();   // calendarId -> display name
  const calName2Ids = new Map();  // display name -> Set(calendarId)

  for (const c of calIterCalendars()) {
    for (const name of [c.summaryOverride, c.summary]) {
      if (name && calReferences.has(name)) {
        calName2Ids.getOrInsert(name, new Set()).add(c.id);
        calReferences.add(c.id);
      }
    }
    if (calReferences.has(c.id)) {
      calId2Name.set(c.id, c.summaryOverride ?? c.summary);
    }
  }

  // Classify configured entries into Active (exact single-ID resolution) or skipped
  const byKey = new Map();        // resolved 'srcId::dstId' -> [ActiveConfig]

  for (const cc of CALENDAR_CONFIG) {
    const sourceIds = new Set();
    const destIds = new Set();

    // A config value may be a literal calendar ID, a display name, or (in a
    // pathological case) both; resolve each interpretation and take the union.
    if (calId2Name.has(cc.source)) { sourceIds.add(cc.source); }
    if (calId2Name.has(cc.destination)) { destIds.add(cc.destination); }

    // If the config references a name, add all matching IDs
    if (calName2Ids.has(cc.source)) {
      for (const id of calName2Ids.get(cc.source)) { sourceIds.add(id); }
    }
    if (calName2Ids.has(cc.destination)) {
      for (const id of calName2Ids.get(cc.destination)) { destIds.add(id); }
    }

    // Active if each side resolves to exactly one ID and they differ
    if (sourceIds.size === 1 && destIds.size === 1) {
      const sourceId = sourceIds.values().next().value;
      const destId = destIds.values().next().value;

      if (sourceId === destId) {
        // Absurd: same calendar for source and destination. Skip.
        console.warn(`Config ${cc.source} -> ${cc.destination} resolves to the same calendar id ${sourceId}; skipping`);
        continue;
      }

      // Construct an ActiveConfig using the resolved IDs. The constructor can
      // no longer fail on expected inputs (absurd pairs are pre-checked above),
      // so a throw here is a programming error and must propagate.
      const ac = new ActiveConfig(cc, props, { sourceId, destId });
      // Defer to the dedup pass below so duplicate (srcId, dstId) pairs are
      // detected before anything is qualified.
      byKey.getOrInsert(ac.key(), []).push(ac);
    } else {
      // Unresolvable (zero matches) or ambiguous (name matches 2+ calendars)
      const why = [];
      if (sourceIds.size === 0) { why.push(`source "${cc.source}" resolves to no calendar`); }
      else if (sourceIds.size > 1) { why.push(`source "${cc.source}" matches ${sourceIds.size} calendars (${Array.from(sourceIds).join(', ')})`); }
      if (destIds.size === 0) { why.push(`destination "${cc.destination}" resolves to no calendar`); }
      else if (destIds.size > 1) { why.push(`destination "${cc.destination}" matches ${destIds.size} calendars (${Array.from(destIds).join(', ')})`); }
      console.warn(`Skipping config ${cc.source} -> ${cc.destination}: ${why.join('; ')}`);
    }
  }

  // Dedup: several config entries may resolve to the same (srcId, dstId) pair.
  // Skip all of them; stored state is still held by the age rule below.
  for (const [key, entries] of byKey) {
    if (entries.length > 1) {
      console.warn(`Multiple config entries for ${key}, skipping all`);
      continue;
    }
    active.push(entries[0]);
    stateKeys.delete(key);
  }

  // Decide which stored state keys to dismiss. Active keys were already deleted
  // from stateKeys above, so every key here no longer matches an active config.
  // Hold state for STATE_RECLAIM_DAYS after its last successful sync to give
  // time to fix a renamed or re-added calendar; after that (or when no syncTime
  // was ever recorded) dismiss it.
  const now = Date.now();
  const reclaimMs = STATE_RECLAIM_DAYS * 86400000;
  for (const key of stateKeys) {
    const [sourceId, destId] = key.split('::');
    const lastSync = props.syncTime?.[key] ?? 0;
    if (now - lastSync < reclaimMs) {
      remembered.push(key);
      continue;
    }

    // Dismissal is state-only: synced replicas are left untouched and will be
    // reconciled on a future full sync.
    const since = lastSync ? `last synced ${new Date(lastSync).toISOString()}` : 'no recorded sync time';
    console.warn(`Identified stale sync state ${sourceId} -> ${destId} (${since})`);
    stale.push(key);
  }

  return [ active, remembered, stale ];
}

class ActiveConfig {
  _shorten(what, length = 11) {
    if (what.length <= length) { return what; } 
    return `${what.slice(0,4)}...${what.slice(-4)}`;
  }

  key() {
    return `${this.sourceId}::${this.destId}`;
  }

  summarize() {
    return `${this.source || '???'} (${this._shorten(this.sourceId || '???')})` +
    ' -> ' +
    `${this.destination || '???'} (${this._shorten(this.destId || '???')})`;
  }

  constructor(config, props, resolvedIds) {

    ['source', 'destination'].forEach( attr => {
      this[attr] = config[attr];
    });

    this.sourceId = resolvedIds.sourceId;
    this.destId = resolvedIds.destId;

    if (this.sourceId === this.destId) {
      throw new Error(`Invalid config: source and destination resolve to same calendar ${this.summarize()}`);
    }

    this.configHash = props.configHash[ this.key() ];
    this.syncToken  = props.syncToken[ this.key() ];
    this.syncTime   = props.syncTime[ this.key() ];
    this.rules = (config.rules || []);

    if (this.configHash && this.configHash !== this.hash()) {
      console.info(`Changed config for ${this.summarize()}`);
      // Keep syncTime: it records the last known-good snapshot time, which the
      // baseline upsert heuristic still uses for events created after it.
      this.syncToken = null;
    } else if (! this.configHash) {
      console.info(`New config for ${this.summarize()}`);
    }
  }

  hash() {
    return generateMd5Hash(JSON.stringify(this.rules));
  }
}
