// vim: set ft=javascript ts=2 sw=2 et:
// Utility functions for deterministic ID generation, execution timing, and properties access

// Use 5 minutes of Apps Script's default 6-minute execution limit.
const EXECUTION_TIMEOUT_MS = 300000;
const EXECUTION_START_MS = Date.now();
const MANAGED_CALENDAR_REGISTRY_KEY = 'MANAGED_CALENDAR_REGISTRY_V1';

function hasExecutionTimeRemainingMs(minimumRemainingMs) {
  return Date.now() - EXECUTION_START_MS < EXECUTION_TIMEOUT_MS - (minimumRemainingMs || 0);
}

/**
 * Resolve configured calendar references to Calendar API IDs using the user's
 * current calendar list. A config reference may match either a calendar ID or
 * the effective display name (summaryOverride when present, otherwise summary).
 *
 * @param {Object[]} calendarConfig - The configured source/destination mappings
 * @return {Object[]} Cloned mappings with resolved sourceCalendarId/destinationCalendarId fields
 */
function resolveCalendarConfig(calendarConfig) {
  const calendarLookup = buildCalendarLookup();
  const resolvedCalendarConfig = [];

  for (const config of calendarConfig) {

    try {
      resolvedCalendarConfig.push(
        Object.assign({}, config, {
          sourceCalendarId: resolveCalendarReference(config.source, calendarLookup),
          destinationCalendarId: resolveCalendarReference(config.destination, calendarLookup)
        })
      );
    } catch (e) {
      console.warn(
        'Skipping calendar pair "' +
        config.source +
        '" -> "' +
        config.destination +
        '" because one or both calendars could not be resolved: ' +
        e.message
      );
    }
  }

  return resolvedCalendarConfig;
}

/**
 * Validate that each source calendar is configured at most once.
 * Sync tokens are keyed only by source calendar ID, so fan-out mappings are
 * unsupported and can lead to incorrect sync state.
 *
 * @param {Object[]} resolvedCalendarConfig - Resolved mappings with sourceCalendarId
 */
function validateUniqueSourceCalendarMappings(resolvedCalendarConfig) {
  const sourceToMappings = {};

  for (const config of resolvedCalendarConfig) {
    if (!sourceToMappings[config.sourceCalendarId]) {
      sourceToMappings[config.sourceCalendarId] = [];
    }
    sourceToMappings[config.sourceCalendarId].push(config);
  }

  const duplicateMessages = [];
  for (const sourceCalendarId in sourceToMappings) {
    const mappings = sourceToMappings[sourceCalendarId];
    if (mappings.length > 1) {
      duplicateMessages.push(
        '"' +
        mappings[0].source +
        '" (' +
        sourceCalendarId +
        ') maps to multiple destinations: ' +
        mappings.map(function(mapping) {
          return '"' + mapping.destination + '" (' + mapping.destinationCalendarId + ')';
        }).join(', ')
      );
    }
  }

  if (duplicateMessages.length > 0) {
    throw new Error(
      'Each source calendar can appear in only one CALENDAR_CONFIG entry. ' +
      duplicateMessages.join('; ')
    );
  }
}

function getManagedCalendarPairKey(sourceCalendarId, destinationCalendarId) {
  return JSON.stringify([sourceCalendarId, destinationCalendarId]);
}

/**
 * Build normalized managed-state arrays from resolved calendar config.
 *
 * @param {Object[]} resolvedCalendarConfig - Resolved mappings with calendar IDs
 * @return {Object} Managed state with pairs and sources arrays
 */
function buildManagedCalendarStateFromResolvedConfig(resolvedCalendarConfig) {
  const pairMap = {};
  const sourceSet = {};

  for (const config of resolvedCalendarConfig) {
    const pairKey = getManagedCalendarPairKey(config.sourceCalendarId, config.destinationCalendarId);
    if (!pairMap[pairKey]) {
      pairMap[pairKey] = {
        sourceCalendarId: config.sourceCalendarId,
        destinationCalendarId: config.destinationCalendarId
      };
    }
    sourceSet[config.sourceCalendarId] = true;
  }

  const pairs = Object.keys(pairMap).sort().map(function(pairKey) {
    return pairMap[pairKey];
  });
  const sources = Object.keys(sourceSet).sort();

  return {
    pairs: pairs,
    sources: sources
  };
}

function normalizeManagedCalendarState(managedState) {
  const normalizedState = managedState || {};
  const pairMap = {};
  const sourceSet = {};

  const pairs = Array.isArray(normalizedState.pairs) ? normalizedState.pairs : [];
  for (const pair of pairs) {
    if (!pair || typeof pair.sourceCalendarId !== 'string' || typeof pair.destinationCalendarId !== 'string') {
      continue;
    }

    const pairKey = getManagedCalendarPairKey(pair.sourceCalendarId, pair.destinationCalendarId);
    if (!pairMap[pairKey]) {
      pairMap[pairKey] = {
        sourceCalendarId: pair.sourceCalendarId,
        destinationCalendarId: pair.destinationCalendarId
      };
    }
    sourceSet[pair.sourceCalendarId] = true;
  }

  const sources = Array.isArray(normalizedState.sources) ? normalizedState.sources : [];
  for (const sourceCalendarId of sources) {
    if (typeof sourceCalendarId === 'string') {
      sourceSet[sourceCalendarId] = true;
    }
  }

  return {
    pairs: Object.keys(pairMap).sort().map(function(pairKey) {
      return pairMap[pairKey];
    }),
    sources: Object.keys(sourceSet).sort()
  };
}

/**
 * Get the managed calendar state snapshot from user properties.
 *
 * @return {Object} Managed state with pairs and sources arrays
 */
function getManagedCalendarState() {
  const props = PropertiesService.getUserProperties();
  const rawRegistry = props.getProperty(MANAGED_CALENDAR_REGISTRY_KEY);

  if (!rawRegistry) {
    return { pairs: [], sources: [] };
  }

  try {
    return normalizeManagedCalendarState(JSON.parse(rawRegistry));
  } catch (e) {
    console.warn('Ignoring invalid managed calendar registry state: ' + e.message);
    return { pairs: [], sources: [] };
  }
}

function hasManagedCalendarStateRegistry() {
  const props = PropertiesService.getUserProperties();
  return props.getProperty(MANAGED_CALENDAR_REGISTRY_KEY) !== null;
}

/**
 * Persist the managed calendar state snapshot to user properties.
 *
 * @param {Object} managedState - Managed state with pairs and sources arrays
 */
function setManagedCalendarState(managedState) {
  const props = PropertiesService.getUserProperties();
  const normalizedState = normalizeManagedCalendarState(managedState);
  props.setProperty(MANAGED_CALENDAR_REGISTRY_KEY, JSON.stringify(normalizedState));
}

/**
 * Build lookup tables from the user's calendar list.
 *
 * @return {Object} Lookup tables keyed by ID and effective display name
 */
function buildCalendarLookup() {
  const byId = {};
  const byName = {};
  let pageToken = null;

  do {
    const response = Calendar.CalendarList.list({
      showHidden: true,
      maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE,
      pageToken: pageToken
    });
    const items = response.items || [];

    for (const item of items) {
      byId[item.id] = item.id;

      const displayName = getCalendarDisplayName(item);
      if (!byName[displayName]) {
        byName[displayName] = [];
      }
      byName[displayName].push(item.id);
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  return {
    byId: byId,
    byName: byName
  };
}

/**
 * Return the effective configured display name for a calendar list item.
 *
 * @param {Object} calendarListItem - A CalendarList entry
 * @return {string} summaryOverride when present, otherwise summary
 */
function getCalendarDisplayName(calendarListItem) {
  return calendarListItem.summaryOverride || calendarListItem.summary || '';
}

/**
 * Resolve a configured source/destination reference to a calendar ID.
 *
 * @param {string} calendarReference - A configured calendar name or ID
 * @param {Object} calendarLookup - Lookup tables from buildCalendarLookup()
 * @return {string} The resolved calendar ID
 */
function resolveCalendarReference(calendarReference, calendarLookup) {
  if (calendarLookup.byId[calendarReference]) {
    return calendarReference;
  }

  const matchingIds = calendarLookup.byName[calendarReference];
  if (!matchingIds || matchingIds.length === 0) {
    throw new Error('Calendar "' + calendarReference + '" was not found in CalendarList');
  }

  if (matchingIds.length > 1) {
    throw new Error(
      'Calendar "' +
      calendarReference +
      '" is ambiguous; matching IDs: ' +
      matchingIds.join(', ')
    );
  }

  return matchingIds[0];
}

// FIXME - GoogleJsonResponseException are well-structured
//
//  { [GoogleJsonResponseException: API call to calendar.events.delete failed with error: Not Found]
//  details: { message: 'Not Found', errors: [ [Object] ], code: 404 },
//  name: 'GoogleJsonResponseException' }

function isGoogleJsonResponseErr(err, ...codes) {
  if (err.details?.code) {
    return codes.includes(err.details.code);
  }
  return false;
}

function isHttpError(error, statusCode, fallbackText) {
  const message = String((error && (error.message || error)) || '');
  const statusPattern = new RegExp('\\b' + String(statusCode) + '\\b');

  return (
    statusPattern.test(message) ||
    (fallbackText && new RegExp(fallbackText, 'i').test(message))
  );
}

/**
 * Remove a calendar event, silently ignoring 404 (not found) and 410 (already
 * deleted) responses so callers are idempotent.
 *
 * @param {string} calendarId - The calendar containing the event
 * @param {string} eventId - The event to remove
 * @return {boolean} true if the event was removed, false if it was already absent
 */
function removeEventIfExists(calendarId, eventId) {
  try {
    Calendar.Events.remove(calendarId, eventId);
    return true;
  } catch (e) {
    if (isHttpError(e, 404, 'Not Found') || isHttpError(e, 410, 'Resource has been deleted')) {
      return false;
    }
    throw e;
  }
}

/**
 * Generate a deterministic destination event ID from source calendar and event IDs.
 * Uses MD5 hash of the concatenation to ensure global uniqueness across all source calendars.
 * 
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} sourceEventId - The original source event ID
 * @return {string} A valid destination event ID (up to 1024 chars supported by Google)
 */
function getDestinationEventId(sourceCalendarId, sourceEventId) {
  if (!sourceCalendarId || !sourceEventId) {
    throw new Error('Source calendar ID and event ID cannot be null or empty');
  }
  
  const compositeKey = sourceCalendarId + '::' + sourceEventId;
  const hash = generateMd5Hash(compositeKey);
  
  return 'gcs' + hash;
}

/**
 * Generate an MD5 hash string from input text.
 * Used for configuration fingerprinting to detect rule changes.
 * 
 * @param {string} text - Input text to hash
 * @return {string} MD5 hash as hexadecimal string
 */
function generateMd5Hash(text) {
  if (text === null || text === undefined) {
    text = '';
  }
  
  const rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    text,
    Utilities.Charset.UTF_8
  );
  
  return rawHash.map(function(byte) {
    const v = (byte < 0) ? 256 + byte : byte;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

/**
 * Get a sync token from user properties for a specific source calendar.
 * 
 * @param {string} sourceCalendarId - The source calendar identifier
 * @return {string|null} The stored sync token, or null if not found
 */
function getSyncToken(sourceCalendarId) {
  const props = PropertiesService.getUserProperties();
  const key = getSyncTokenPropertyKey(sourceCalendarId);
  return props.getProperty(key);
}

/**
 * Store a sync token in user properties for a specific source calendar.
 * 
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} syncToken - The sync token to store
 */
function setSyncToken(sourceCalendarId, syncToken) {
  const props = PropertiesService.getUserProperties();
  const key = getSyncTokenPropertyKey(sourceCalendarId);
  props.setProperty(key, syncToken);
}

/**
 * Remove the stored sync token for a specific source calendar.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 */
function clearSyncToken(sourceCalendarId) {
  const props = PropertiesService.getUserProperties();
  const key = getSyncTokenPropertyKey(sourceCalendarId);
  props.deleteProperty(key);
}

function getSyncTokenPropertyKey(sourceCalendarId) {
  return 'SYNC_TOKEN_' + encodeURIComponent(sourceCalendarId);
}

/**
 * Recursively normalize a config value for stable hashing:
 * - RegExp objects are converted to their toString() representation
 * - Object keys are sorted for deterministic order
 * - Arrays and primitives are passed through
 *
 * @param {*} value - Value to normalize
 * @return {*} Normalized value suitable for JSON.stringify
 */
function normalizeConfigForHash(value) {
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeConfigForHash);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).sort().reduce(function(acc, key) {
      acc[key] = normalizeConfigForHash(value[key]);
      return acc;
    }, {});
  }
  return value;
}

/**
 * Get the stored rules hash for a specific calendar pair.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @return {string|null} The stored hash, or null if not found
 */
function getCalendarPairConfigHash(sourceCalendarId, destCalendarId) {
  const props = PropertiesService.getUserProperties();
  const key = getCalendarPairConfigHashPropertyKey(sourceCalendarId, destCalendarId);
  return props.getProperty(key);
}

/**
 * Store the rules hash for a specific calendar pair.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Array} rules - The rules array to hash and store
 */
function setCalendarPairConfigHash(sourceCalendarId, destCalendarId, rules) {
  const hash = generateMd5Hash(JSON.stringify(normalizeConfigForHash(rules)));
  const props = PropertiesService.getUserProperties();
  const key = getCalendarPairConfigHashPropertyKey(sourceCalendarId, destCalendarId);
  props.setProperty(key, hash);
}

/**
 * Remove the stored rules hash for a specific calendar pair.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 */
function clearCalendarPairConfigHash(sourceCalendarId, destCalendarId) {
  const props = PropertiesService.getUserProperties();
  const key = getCalendarPairConfigHashPropertyKey(sourceCalendarId, destCalendarId);
  props.deleteProperty(key);
}

function getCalendarPairConfigHashPropertyKey(sourceCalendarId, destCalendarId) {
  return 'CONFIG_HASH_' + encodeURIComponent(sourceCalendarId) + '_' + encodeURIComponent(destCalendarId);
}

/**
 * Generate a deterministic destination instance ID for a recurring event exception.
 * Relies on Google Calendar's documented instance ID format: <masterId>_<timestamp>.
 * The timestamp suffix is extracted from the source exception ID and appended to the
 * destination master ID.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {Object} sourceExceptionItem - The source exception event (must have recurringEventId)
 * @return {string} The corresponding destination instance ID
 */
function getDestinationInstanceId(sourceCalendarId, sourceExceptionItem) {
  const destMasterId = getDestinationEventId(sourceCalendarId, sourceExceptionItem.recurringEventId);
  const suffix = sourceExceptionItem.id.slice(sourceExceptionItem.recurringEventId.length + 1);
  return destMasterId + '_' + suffix;
}

/**
 * Check whether the rules for a specific calendar pair have changed since
 * the last successful sync. Returns true if rules changed or no hash stored yet.
 *
 * @param {Object} config - Resolved calendar config with sourceCalendarId, destinationCalendarId, and rules
 * @return {boolean} True if rules have changed, false otherwise
 */
function checkCalendarPairConfigChange(config) {
  const currentHash = generateMd5Hash(JSON.stringify(normalizeConfigForHash(config.rules)));
  const storedHash = getCalendarPairConfigHash(config.sourceCalendarId, config.destinationCalendarId);
  return currentHash !== storedHash;
}
