Where to inject this in SyncEngine.gs:
Add this guard clause at the absolute top of your payload processing logic, right before evaluating rules or computing deterministic IDs:

JavaScript
function processSyncItem(item, config, destCalendarId) {
  // 1. GUARD CLAUSE: Prevent infinite loop feedback
  if (item.extendedProperties && 
      item.extendedProperties.private && 
      item.extendedProperties.private.sourceCalendarId) {
    
    // Log it so you can see the protection working in your executions dashboard
    Logger.log(`Loop Guard: Skipping event "${item.summary}" because it is an active sync replica.`);
    return; 
  }

  // 2. Proceed with normal execution if it's a native source event...
  const destId = getDestinationEventId(sourceCalendarId, item.id);
  // ... rest of your code
}
