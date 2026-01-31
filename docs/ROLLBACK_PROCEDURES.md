# Rollback Procedures - Intelligent Fix System
**Phase 0: Emergency Rollback Guide**

## Quick Rollback (Emergency)

If you need to immediately disable all new features and revert to the original system:

```bash
# 1. Stop the server
# Press Ctrl+C or kill the process

# 2. Disable all feature flags
cd d:\AICloudBuilder
echo "ENABLE_USER_FIX_PREFERENCES=false" >> .env
echo "ENABLE_CHECKOV_NATIVE_FETCH=false" >> .env
echo "ENABLE_INTELLIGENT_FIX_RETRIEVAL=false" >> .env

# 3. Restart the server
npm run dev
```

**Result:** All new features are disabled. The system reverts to using:
- Existing RAG service with fix snippet store
- Template-based remediation (13 YAML files)
- No user-specific preferences
- No Checkov native fetching

---

## Phase-Specific Rollback Procedures

### Phase 0: Monitoring & Feature Flags

**What was added:**
- Performance logging (`server/utils/performance-logger.ts`)
- Metrics dashboard endpoints (`server/routes/metrics.ts`)
- Feature flag system (`server/middleware/feature-flags.ts`)
- Cost tracking in vector store
- Baseline analysis script

**Rollback Steps:**

1. **Disable metrics endpoints** (optional - they don't affect core functionality)
   ```typescript
   // In server/routes/index.ts, comment out:
   // registerMetricsRoutes(app);
   ```

2. **Remove performance logging** (if causing issues)
   ```typescript
   // In server/rag/remediation-rag.ts
   // Comment out all performanceLogger.start() and performanceLogger.end() calls
   ```

3. **Revert to old findRemediation()**
   ```bash
   git diff server/rag/remediation-rag.ts
   # Review changes and revert if needed
   git checkout HEAD -- server/rag/remediation-rag.ts
   ```

**Impact:** Monitoring disabled, but core fix functionality unchanged.

---

### Phase 1: Database Schema (User Fix Preferences)

**What was added:**
- `user_fix_preferences` table in PostgreSQL
- Migration file

**Rollback Steps:**

1. **Drop the table**
   ```sql
   -- Connect to PostgreSQL
   psql postgresql://postgres:Jeffy5%4012345@localhost:5432/aicloudops

   -- Drop table
   DROP TABLE IF EXISTS user_fix_preferences CASCADE;

   -- Verify
   \dt user_fix_preferences
   ```

2. **Remove migration file**
   ```bash
   rm -f drizzle/0001_user_fix_preferences.sql
   ```

3. **Revert schema changes**
   ```bash
   git checkout HEAD -- shared/schema.ts
   ```

**Impact:** Removes user-specific preferences. Global fix cache still works.

---

### Phase 2: User Fix Preferences Service

**What was added:**
- `server/rag/user-fix-preferences-store.ts`
- API endpoints in `server/routes/user-fix-preferences.ts`

**Rollback Steps:**

1. **Unregister routes**
   ```typescript
   // In server/routes/index.ts, comment out:
   // registerUserFixPreferencesRoutes(app);
   ```

2. **Disable feature flag**
   ```bash
   # In .env
   ENABLE_USER_FIX_PREFERENCES=false
   ```

3. **Delete files** (optional)
   ```bash
   rm server/rag/user-fix-preferences-store.ts
   rm server/routes/user-fix-preferences.ts
   ```

**Impact:** User preferences disabled, but system continues using global cache.

---

### Phase 3: Checkov Native Remediation

**What was added:**
- `server/scoreme/checkov-remediator.ts`
- Cheerio dependency

**Rollback Steps:**

1. **Disable feature flag**
   ```bash
   # In .env
   ENABLE_CHECKOV_NATIVE_FETCH=false
   ```

2. **Remove service** (optional)
   ```bash
   rm server/scoreme/checkov-remediator.ts
   ```

3. **Uninstall dependency** (optional)
   ```bash
   npm uninstall cheerio @types/cheerio
   ```

**Impact:** Stops fetching from Checkov docs. Falls back to templates and global cache.

---

### Phase 4: Intelligent Fix Retriever

**What was added:**
- `server/rag/intelligent-fix-retriever.ts`
- 5-tier retrieval system

**Rollback Steps:**

1. **Disable feature flag**
   ```bash
   # In .env
   ENABLE_INTELLIGENT_FIX_RETRIEVAL=false
   ```

2. **Revert endpoint changes**
   ```bash
   # Check what changed in terraform routes
   git diff server/routes/terraform.ts

   # If needed, revert
   git checkout HEAD -- server/routes/terraform.ts
   ```

**Impact:** Disables intelligent retrieval. Uses old RAG service with templates.

---

### Phase 5-8: Not Yet Implemented

These phases haven't been implemented yet, so no rollback needed.

---

## Verification After Rollback

After performing any rollback, verify the system works:

1. **Start the server**
   ```bash
   npm run dev
   ```

2. **Check feature flags**
   ```bash
   curl http://localhost:9005/api/metrics/feature-flags
   ```

3. **Test fix retrieval**
   - Create a session
   - Run Checkov scan
   - Try to apply a fix
   - Verify it works

4. **Check logs**
   ```bash
   # Server logs should show:
   # - Feature flags disabled
   # - No errors
   # - Old system working
   ```

---

## Emergency Contacts

If rollback fails or issues persist:

1. **Check GitHub Issues**: https://github.com/yourusername/AICloudBuilder/issues
2. **Review recent commits**: `git log --oneline -20`
3. **Restore from backup**: `git reset --hard <commit-hash>`

---

## Rollback Decision Matrix

| Symptom | Phase Likely Affected | Rollback Action |
|---------|----------------------|-----------------|
| Server won't start | Phase 0 (middleware) | Disable feature flags |
| Database errors | Phase 1 (schema) | Drop user_fix_preferences table |
| API endpoint errors | Phase 2 (routes) | Unregister new routes |
| Slow performance | Phase 0 (logging) | Disable performance logging |
| Fix retrieval fails | Phase 4 (intelligent retriever) | Disable ENABLE_INTELLIGENT_FIX_RETRIEVAL |
| Cost tracking errors | Phase 0 (vector-store) | Revert vector-store.ts changes |

---

## Nuclear Option: Complete Revert

If all else fails, revert to the commit before Phase 0:

```bash
# Find the commit before Phase 0
git log --oneline --grep="Phase 0"

# Create a backup branch
git branch backup-broken-state

# Hard reset to before Phase 0
git reset --hard <commit-before-phase-0>

# Force push (if already pushed)
git push --force origin main
```

**⚠️ WARNING:** This will lose all work from Phase 0 onwards. Only use if absolutely necessary.

---

## Post-Rollback Checklist

- [ ] Server starts without errors
- [ ] Feature flags show disabled status
- [ ] Fix retrieval works with templates
- [ ] No database errors
- [ ] API endpoints respond correctly
- [ ] Logs show no warnings
- [ ] Tests pass (if applicable)

---

## Prevention for Future Phases

To avoid needing rollbacks:

1. **Always use feature flags** for new features
2. **Test in development first** before enabling in production
3. **Document all changes** in git commits
4. **Keep rollback procedures updated** for each phase
5. **Monitor metrics** during rollout
6. **Enable gradually** (10% → 50% → 100%)

---

*Last Updated: Phase 0 - January 31, 2026*
