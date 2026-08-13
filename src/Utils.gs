// vim: set ft=javascript ts=2 sw=2 et:

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
 * Error thrown when we reach our soft deadline, giving
 * the script enough time to shut down gracefully.
 */
class SoftTimeoutError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    if ('captureStackTrace' in Error) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Raise an error if we've reached our soft deadline
 *
 * @throws {SoftTimeoutError}
 */
const scriptTimeCheck = (function() {
  const scriptSoftDeadline = SCRIPT_BASETIME + SCRIPT_TIMEOUT_MS; // 00Init

  return function() {
    if (Date.now() >= scriptSoftDeadline) {
      throw new SoftTimeoutError("Execution deadline reached");
    }
  }
})();

/**
 * Return true if the given exception is a Google API JSON response error
 * whose HTTP status code is one of the given codes.
 *
 * Advanced Calendar Service failures throw an exception whose `details`
 * carries `{ code, message, errors: [...] }`; `status` covers other
 * HTTP-shaped errors.
 *
 * @param {*} e - The thrown exception object
 * @param {...number} codes - HTTP status codes to match
 * @return {boolean} True if the exception's status code is in `codes`
 */
function isGoogleJsonResponseErr(e, ...codes) {
  if (!e || typeof e !== 'object') { return false; }
  const code = e.details?.code ?? e.code ?? e.status;
  return codes.includes(code);
}
