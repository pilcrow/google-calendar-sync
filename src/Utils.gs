// vim: set ft=javascript ts=2 sw=2 et:
// Utility functions for deterministic ID generation, MD5 hashing, and properties access

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
 * Get a sync token from script properties for a specific source calendar.
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
 * Store a sync token in script properties for a specific source calendar.
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
 * Get the stored configuration hash from script properties.
 * 
 * @return {string|null} The stored config hash, or null if not found
 */
function getConfigHash() {
  const props = PropertiesService.getUserProperties();
  return props.getProperty('CONFIG_HASH');
}

/**
 * Store the configuration hash in script properties.
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
