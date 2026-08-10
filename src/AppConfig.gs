// vim: set ft=javascript ts=2 sw=2 et:
//
// Management of app config and state

let SCRIPT_PROPERTIES;

function propsLoad() {
  // UserProperties :=
  //   { syncToken: '{"srcA::dstA":"token1", "srcB::dstA":"token2", ...}, ... }'
  //   { configHash: '{"srcA::dstA":"hash1", "srcB::dstA":"hash2", ...}, ... }'
  //

  SCRIPT_PROPERTIES = PropertiesService.getUserProperties();
  const props = SCRIPT_PROPERTIES.getProperties();

  for (const a of ['syncToken', 'configHash']) {
    if (props[a]) {
      props[a] = JSON.parse(props[a]);
    } else {
      props[a] = {};
    }
  }

  return props;
}

function propsStore(props) {
  const store = {};
  for (const a of ['syncToken', 'configHash']) {
    store[a] = JSON.stringify(props[a] || {});
  }
  SCRIPT_PROPERTIES.setProperties(store);
}

function qualifyConfig(props) {
  const [ qualified, removed ] = [ [], [] ];
  const calMap = new Map();
  const tempStore = new Map();

  const referencedCals = new Set(CALENDAR_CONFIG.flatMap((cc) => [cc.source, cc.destination]).filter((x) => x != null));
  const propsPairs = new Set(['syncToken', 'configHash'].flatMap( attr => Object.keys(props[attr]) ));
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
    this.sourceId = sourceId;
    this.source = calId2Name.get(this.sourceId);
    this.destId = destId;
    this.destination = calId2Name.get(this.destId);
  }
}

class ActiveConfig extends RuntimeConfig {
  constructor(config, name2IdMap, props) {
    ['source', 'destination'].forEach( attr => {
      this[attr] = config[attr];
    });

    this.sourceId = name2IdMap.get(this.source);
    if (!this.sourceId) { throw new Error(`Invalid source calendar ${this.summarize()}`);
    this.destId = name2IdMap.get(this.destination);
    if (!this.destId) { throw new Error(`Invalid destination calendar ${this.summarize()}`);

    this.configHash = props[ this.key() ]?.configHash
    this.syncToken  = props[ this.key() ]?.syncToken
    this.rules = (config.rules || []);

    if (this.configHash && this.configHash !== this.hash()) {
      console.info(`Changed config for ${this.summarize()}`);
      this.syncToken = null;
    } else if (! this.configHash) {
      console.info(`New config for ${this.summarize()}`);
    }

  }

  hash() {
    return generateMd5Hash(JSON.stringify(this.rules));
  }
}
