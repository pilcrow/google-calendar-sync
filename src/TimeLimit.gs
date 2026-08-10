// vim: set ft=javascript ts=2 sw=2 et:

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
const timeCheck = (function() {
  const scriptSoftDeadline = SCRIPT_BASETIME + SCRIPT_TIMEOUT_MS; // 00Init

  return function() {
    if (Date.now() >= scriptSoftDeadline) {
      throw new SoftTimeoutError("Execution deadline reached");
    }
  }
})();
