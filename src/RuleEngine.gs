// vim: set ft=javascript ts=2 sw=2 et:
// Rule evaluation engine for filtering and modifying events based on summary text

/**
 * Evaluate an event's summary against a set of ordered rules.
 * Rules are processed in order; the first matching rule wins.
 * 
 * @param {string|null} summary - The event summary (title) to evaluate
 * @param {Array<Object>} rules - Array of rule objects with optional match, skip, prefix, colorId
 * @return {Object} Action object with properties: skip (boolean), prefix (string), colorId (string)
 */
function evaluateRules(summary, rules) {
  if (summary === null || summary === undefined) {
    summary = '';
  }
  
  const result = {
    skip: false,
    prefix: '',
    colorId: null
  };
  
  if (!rules || rules.length === 0) {
    return result;
  }
  
  for (const rule of rules) {
    
    let matches = false;
    if (rule.match) {
      matches = rule.match.test(summary);
    } else {
      matches = true;
    }
    
    if (matches) {
      if (rule.skip === true) {
        result.skip = true;
      }
      
      if (rule.prefix) {
        result.prefix = rule.prefix;
      }
      
      if (rule.colorId !== null && rule.colorId !== undefined) {
        result.colorId = String(rule.colorId);
      }
      
      break;
    }
  }
  
  return result;
}
