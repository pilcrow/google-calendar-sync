// vim: set ft=javascript ts=2 sw=2 et:
//
// Management of app config and state

  // UserProperties :=
  //   { syncToken: '{"srcA::dstA":"token1", "srcB::dstA":"token2", ...}, ... }'
  //   { configHash: '{"srcA::dstA":"hash1", "srcB::dstA":"hash2", ...}, ... }'
  //   { syncTime: '{"srcA::dstA":1712345678901, ...}, ... }'
  //
class ScriptProperties {
  // Not in Google Apps Script; see after class
  // static GasUserProperties = null;
  // static ConfigPairStateKey = ['syncToken', ...];

  function constructor(props) {
    this = {...props};
  }

  function allKeys() {
    return new Set(ScriptProperties.ConfigPairStateKeys.flatMap( attr => Object.keys(props[attr] ?? {}) ));
  }

  function clear(key) {
    ScriptProperties.ConfigPairStateKeys.forEach(k =>
      delete this[attr]?.[key];
    )
  }

  function update(key, kvObj) {
    for (const attr of ScriptProperties.ConfigPairStateKeys) {
      if (attr in kvObj) {
        this[attr] ||= {};
        if (kvObj[attr] != null) {
          this[attr][key] = kbObj[attr];
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
      props[a] ||= '{}';
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

function qualifyConfig(props) {
  const [ qualified, removed ] = [ [], [] ];
  const calMap = new Map(); // id -> name and name -> id

  const referencedCals = new Set(CALENDAR_CONFIG.flatMap((cc) => [cc.source, cc.destination]).filter((x) => x != null));
  const propsPairs = props.allKeys();
  const allPropsIds = new Set(propsPairs.flatMap( p => p.split('::') ));

  calStreamCalendars( cal => {
    for (const summ of ['summaryOverride', 'summary']) {
      if (cal[summ] && referencedCals.has(cal[summ])) {
        calMap.set(cal[summ], cal.id);
        calMap.set(cal.id, cal[summ]);
        continue;
      } else if (allPropsIds.has(cal.id)) {
        calMap.set(cal.id, cal.summaryOverride ?? cal.summary);
      }
    }
  });

  const tempStore = new Map();
  for (const cc of CALENDAR_CONFIG) {
    let ac;
    try {
      ac = new ActiveConfig(cc, calMap, props);
    } catch (e) {
      console.warn(e.message);
      continue;
    }
    (tempStore[ ac.key() ] ||= []).push( ac );
    propsPairs.delete(ac.key());
  }

  // skip dupes
  for (const v of tempStore.values()) {
    if (v.length > 1) {
      console.error(`Multiple config entries for ${v[0].key()}, skipping all`);
      continue;
    }
    qualified.push( v[0] );
  }

  // skip deleted configs we can't prune
  // N.B.: we can still prune old syncs even if the _source_ is gone.
  for (const [sourceId, destId] of propsPairs.map(k => k.split('::'))) {
    if (! allPropsIds.has(destId)) {
      console.error(`Skipping unresolvable, deleted config for ${sourceId} -> ${destId}`);
      next;
    }
    removed.push( new InactiveConfig(sourceId, destId, calMap) );
  }

  return [ qualified, removed ];
}

class RuntimeConfig {
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
}

class InactiveConfig extends RuntimeConfig {
  constructor(sourceId, destId, calId2Name) {
    super();
    this.sourceId = sourceId;
    this.source = calId2Name.get(this.sourceId);
    this.destId = destId;
    this.destination = calId2Name.get(this.destId);
  }
}

class ActiveConfig extends RuntimeConfig {
  constructor(config, name2IdMap, props) {
    super();

    ['source', 'destination'].forEach( attr => {
      this[attr] = config[attr];
    });

    this.sourceId = name2IdMap.get(this.source);
    if (!this.sourceId) { throw new Error(`Invalid source calendar ${this.summarize()}`); }
    this.destId = name2IdMap.get(this.destination);
    if (!this.destId) { throw new Error(`Invalid destination calendar ${this.summarize()}`); }

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
