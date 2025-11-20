# Checkov Scan & Cost Analysis Approach

## Current Implementation

### Checkov Scan (`/api/sessions/:id/scan`)
- **Gets files from**: Session storage
- **Code**: `const allFiles = await storage.getFilesBySession(sessionId);`
- **Issue**: Depends on files being stored in session

### Cost Analysis (`/api/sessions/:id/analyze-cost`)
- **Gets files from**: Session storage
- **Code**: `const allFiles = await storage.getFilesBySession(sessionId);`
- **Issue**: Depends on files being stored in session

## Your Question

**Should Checkov scan and cost analysis also fetch directly from the repository when the button is clicked?**

## Answer: **YES!** ✅

### Why Fetch Directly from Repository?

1. **Consistency**: Same approach as generation (append)
   - Generation: Fetches from repo → Appends → Updates
   - Checkov: Should fetch from repo → Scan → Report
   - Cost Analysis: Should fetch from repo → Analyze → Report

2. **Always Fresh**: Gets latest code from repository
   - No stale data from session storage
   - Reflects actual repository state

3. **More Reliable**: No dependency on session storage
   - Works even if files weren't stored
   - No storage step to fail

4. **Simpler**: One source of truth (repository)
   - No need to manage file storage
   - Cleaner code flow

## Proposed Implementation

### Checkov Scan
```typescript
app.post("/api/sessions/:id/scan", async (req, res) => {
  const session = await storage.getSession(sessionId);
  
  // Fetch files directly from repository
  const files = await mcpClient.scanRepositoryFiles(
    session.provider,
    session.repositoryName,
    'main'
  );
  
  // Filter to Terraform files only
  const tfFiles = files.filter(f => f.path.endsWith('.tf'));
  
  // Write to temp directory and run Checkov
  // ... rest of scan logic
});
```

### Cost Analysis
```typescript
app.post("/api/sessions/:id/analyze-cost", async (req, res) => {
  const session = await storage.getSession(sessionId);
  
  // Fetch files directly from repository
  const files = await mcpClient.scanRepositoryFiles(
    session.provider,
    session.repositoryName,
    'main'
  );
  
  // Filter to Terraform files only
  const tfFiles = files.filter(f => f.path.endsWith('.tf'));
  
  // Parse resources and calculate costs
  // ... rest of cost analysis logic
});
```

## Benefits

1. ✅ **Consistent**: All operations (generate, scan, cost) fetch from repo
2. ✅ **Reliable**: Always works, no storage dependency
3. ✅ **Fresh**: Always analyzes latest code
4. ✅ **Simple**: One approach for all operations

## What Session Storage Is Still Needed For

Session storage should only store:
- **Session metadata**: provider, repositoryName, moduleApproach, etc.
- **Backend configuration**: backend settings
- **Workflow state**: current step, workflow step

Session storage should NOT store:
- ❌ Terraform file contents (fetch from repo when needed)
- ❌ Generated code (commit directly to repo)

## Summary

**Yes, Checkov scan and cost analysis should fetch directly from the repository when the button is clicked**, just like generation does. This ensures consistency, reliability, and freshness across all operations.

