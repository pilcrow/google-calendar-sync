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
