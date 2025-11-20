# MCP push_files Tool Issue - Diagnosis Report

**Date:** November 16, 2025  
**Issue:** `push_files` fails with "Resource not found" when committing to existing repository

---

## Test Results

### ✅ Files Preparation: WORKING
- Files are correctly appended to existing content
- Format is correct for MCP
- 4 files ready for commit (main.tf, outputs.tf, variables.tf, terraform.tfvars)

### ❌ push_files Tool: FAILING
- Error: `MCP error -32603: Not Found: Resource not found: Not Found`
- Error Code: `-32603` (JSON-RPC Internal Error)
- Error Type: "Not Found"

---

## push_files Tool Schema Analysis

### Parameters Available
```
Required: ["owner", "repo", "branch", "files", "message"]

Properties:
  - owner: string (Repository owner)
  - repo: string (Repository name)
  - branch: string (Branch to push to)
  - files: array (Array of files to push)
  - message: string (Commit message)
```

### ❌ Missing Parameters
- **No `base_sha` or `parent_sha` parameter**
- **No `file_sha` parameter for existing files**
- **No `update` flag to indicate updates vs creates**

**Conclusion:** `push_files` tool schema does NOT include parameters for updating existing files.

---

## Root Cause Analysis

### Hypothesis 1: push_files Doesn't Support Updates
**Evidence:**
- Tool schema has no SHA parameters
- Tool schema has no update flag
- Tool only accepts: owner, repo, branch, files, message

**What this means:**
- `push_files` might be designed only for **creating new files**
- When files already exist, it fails
- The "Resource not found" might be because it's trying to create a commit without a parent

### Hypothesis 2: push_files Needs Implicit Base Commit
**Evidence:**
- Error is "Resource not found"
- Repository has files and commits
- Branch exists

**What this means:**
- `push_files` might internally try to get the current HEAD
- If it can't find the branch reference, it fails
- OR it needs the branch to have at least one commit

### Hypothesis 3: push_files Needs File SHAs for Updates
**Evidence:**
- GitHub REST API requires file SHA for updates
- We're only sending file content, not SHAs
- Files already exist in repository

**What this means:**
- `push_files` might need file SHAs to know which files to update
- Without SHAs, it might try to create new files
- When files already exist, it conflicts and fails

---

## What We're Sending to push_files

### Current Parameters
```typescript
{
  owner: "jeffy555",
  repo: "my-repo-jeff",
  branch: "main",
  files: [
    { path: "main.tf", content: "..." },      // Existing file - being updated
    { path: "outputs.tf", content: "..." },   // Existing file - being updated
    { path: "variables.tf", content: "..." }, // Existing file - being updated
    { path: "terraform.tfvars", content: "..." } // New file - being created
  ],
  message: "AI-generated commit message"
}
```

### What's Missing (if needed)
```typescript
{
  // Missing: base_sha or parent_sha
  // Missing: file SHAs for existing files
  // Missing: update flag
}
```

---

## Comparison: GitHub REST API vs push_files

### GitHub REST API (Works for Updates)
```typescript
PUT /repos/{owner}/{repo}/contents/{path}
{
  message: "commit message",
  content: "base64-encoded-content",
  sha: "file-sha-for-updates",  // ✅ Required for updates
  branch: "main"
}
```

**Key Difference:**
- REST API requires `sha` parameter for updates
- `push_files` has no `sha` parameter

### push_files Tool (Fails for Updates)
```typescript
push_files({
  owner: "...",
  repo: "...",
  branch: "...",
  files: [{ path: "...", content: "..." }],  // ❌ No SHA
  message: "..."
})
```

**Key Difference:**
- No way to specify file SHA
- No way to indicate update vs create
- Might be designed only for new files

---

## Files Being Committed

### From Test Results:
1. **main.tf** (1592 chars)
   - Status: **EXISTING FILE** (being updated)
   - Content: Existing resources + new storage account
   - First line: `"--- main.tf (EXISTING) ---"`

2. **outputs.tf** (597 chars)
   - Status: **EXISTING FILE** (being updated)
   - Content: Existing outputs + new outputs
   - First line: `"--- outputs.tf (EXISTING) ---"`

3. **variables.tf** (323 chars)
   - Status: **EXISTING FILE** (being updated)
   - Content: Existing variables + new variable
   - First line: `"--- variables.tf (EXISTING) ---"`

4. **terraform.tfvars** (98 chars)
   - Status: **NEW FILE** (being created)
   - Content: New variable values
   - First line: `"--- terraform.tfvars (EXISTING) ---"`

**Note:** All files show "(EXISTING)" in first line, which suggests they were fetched from repository and then appended to.

---

## The Problem

### What's Happening:
1. ✅ Files are correctly prepared (append verified)
2. ✅ Files are correctly formatted
3. ✅ Files are sent to `push_files` with correct structure
4. ❌ `push_files` fails because:
   - It doesn't know these are updates to existing files
   - It might be trying to create new files
   - When files already exist, it conflicts
   - OR it needs base commit SHA that we're not providing

### Why "Resource not found"?
The error "Resource not found" could mean:
1. **Branch reference not found** - But branch exists ✅
2. **Base commit SHA not found** - push_files might need this internally
3. **Tree SHA not found** - push_files might need current tree
4. **File SHA not found** - push_files might need this for updates

---

## Recommendations

### Option 1: Use GitHub REST API for Existing Repos (Recommended)
**Why:**
- ✅ Known to work for both create and update
- ✅ Requires file SHA for updates (we can get this)
- ✅ Handles existing files correctly

**Implementation:**
- Check if repository has files before commit
- If files exist → Use REST API
- If repository is empty → Use `push_files`

### Option 2: Get File SHAs and Add to push_files (If Supported)
**Why:**
- Might work if push_files supports it internally
- Need to check if files array can include SHA

**Implementation:**
- Before commit, get file SHAs from repository
- Add SHA to file objects: `{ path, content, sha }`
- Try push_files with SHAs

### Option 3: Get Base Commit SHA and Add to push_files (If Supported)
**Why:**
- push_files might need parent commit
- Could add as optional parameter

**Implementation:**
- Get current branch HEAD SHA
- Add `base_sha` or `parent_sha` to push_files call
- Check if tool accepts it (even if not in schema)

### Option 4: Check GitHub MCP Server Documentation
**Why:**
- Need to understand what push_files actually does
- Might have undocumented parameters
- Might have limitations we don't know about

---

## Next Steps

1. **Check Server Console Logs**
   - Look for detailed MCP error
   - See what "Resource" is not found
   - Check if push_files logs show what it's trying to do

2. **Test with Base Commit SHA**
   - Get current HEAD SHA
   - Try adding it to push_files call
   - See if it helps

3. **Test with File SHAs**
   - Get SHAs for existing files
   - Add to files array
   - See if push_files accepts them

4. **Use GitHub REST API Fallback**
   - For existing repositories, use REST API
   - For empty repositories, use push_files
   - This is the safest approach

---

## Conclusion

### Root Cause:
**`push_files` tool likely doesn't support updating existing files, or needs additional context (SHAs) that we're not providing.**

### Evidence:
- ✅ Files are correctly prepared
- ✅ Format is correct
- ❌ push_files schema has no SHA/update parameters
- ❌ push_files fails with "Resource not found"

### Solution:
**Use GitHub REST API for existing repositories (updates), and `push_files` only for new repositories (creates).**

---

## Test Files Created

1. `test-append-verification.js` - Verified append is working ✅
2. `test-push-files-issue.js` - Tested commit and captured error ❌
3. `test-push-files-with-sha.js` - Analyzed push_files schema and requirements

**All tests confirm:**
- Append logic is working correctly
- Files are correctly formatted
- `push_files` tool is failing for existing repositories

