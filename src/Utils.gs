// vim: set ft=javascript ts=2 sw=2 et:
// Utility functions for deterministic ID generation, execution timing, and properties access

// Use 5 minutes of Apps Script's default 6-minute execution limit.
const EXECUTION_TIMEOUT_MS = 300000;
const EXECUTION_START_MS = Date.now();
const CALENDAR_LIST_MAX_RESULTS = 250;

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

  for (let i = 0; i < calendarConfig.length; i++) {
    const config = calendarConfig[i];

    try {
      resolvedCalendarConfig.push(
        Object.assign({}, config, {
          sourceCalendarId: resolveCalendarReference(config.source, calendarLookup),
          destinationCalendarId: resolveCalendarReference(config.destination, calendarLookup)
        })
      );
    } catch (e) {
      Logger.log(
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
      maxResults: CALENDAR_LIST_MAX_RESULTS,
      pageToken: pageToken
    });
    const items = response.items || [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
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

function isHttpError(error, statusCode, fallbackText) {
  const message = String((error && (error.message || error)) || '');
  const statusPattern = new RegExp('\\b' + String(statusCode) + '\\b');

  return (
    statusPattern.test(message) ||
    (fallbackText && new RegExp(fallbackText, 'i').test(message))
  );
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
  const key = 'SYNC_TOKEN_' + encodeURIComponent(sourceCalendarId);
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
  const key = 'SYNC_TOKEN_' + encodeURIComponent(sourceCalendarId);
  props.setProperty(key, syncToken);
}

/**
 * Get the stored configuration hash from user properties.
 * 
 * @return {string|null} The stored config hash, or null if not found
 */
function getConfigHash() {
  const props = PropertiesService.getUserProperties();
  return props.getProperty('CONFIG_HASH');
}

/**
 * Store the configuration hash in user properties.
 * 
 * @param {string} hash - The MD5 hash of the current configuration
 */
function setConfigHash(hash) {
  const props = PropertiesService.getUserProperties();
  props.setProperty('CONFIG_HASH', hash);
}

/**
 * Generate a hash of the current CALENDAR_CONFIG and check if it differs
 * from the stored hash. Returns true if configuration has changed.
 * 
 * @return {boolean} True if config has changed, false otherwise
 */
function checkConfigChange() {
  const currentConfigJson = JSON.stringify(CALENDAR_CONFIG);
  const currentHash = generateMd5Hash(currentConfigJson);
  const storedHash = getConfigHash();
  
  return currentHash !== storedHash;
}
