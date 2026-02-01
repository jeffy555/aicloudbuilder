# Phase 2: User Fix Preferences API Documentation

**Base URL:** `http://localhost:9005`
**Authentication:** JWT Bearer token (from `/api/auth/signup` or `/api/auth/login`)

---

## Authentication

All endpoints under `/api/users/me/fix-preferences` require authentication via Bearer token.

```
Authorization: Bearer <token>
```

The public endpoint (`/api/fix-preferences/check/...`) does not require authentication.

---

## Endpoints

### 1. List All Preferences

**GET** `/api/users/me/fix-preferences`

Returns all fix preferences for the authenticated user with pagination.

| Query Param | Type   | Default | Description          |
|-------------|--------|---------|-------------------   |
| `limit`     | number | 100     | Max results to return |
| `offset`    | number | 0       | Pagination offset     |

**Response 200:**
```json
{
  "preferences": [
    {
      "id": "uuid",
      "userId": "uuid",
      "checkId": "CKV_AZURE_59",
      "resourceType": "azurerm_storage_account",
      "fixSnippet": "allow_nested_items_to_be_public = false",
      "confidence": 0.95,
      "timesUsed": 3,
      "successCount": 2,
      "failureCount": 1,
      "source": "user_verified",
      "lastUsedAt": "2026-01-31T...",
      "createdAt": "2026-01-31T...",
      "updatedAt": "2026-01-31T..."
    }
  ],
  "count": 1,
  "limit": 100,
  "offset": 0
}
```

---

### 2. Get Preferences Statistics

**GET** `/api/users/me/fix-preferences/stats`

Returns aggregated statistics for the authenticated user's fix preferences.

**Response 200:**
```json
{
  "totalPreferences": 5,
  "totalUsages": 12,
  "successRate": 0.83,
  "averageConfidence": 0.87,
  "bySource": {
    "user_verified": 2,
    "checkov": 2,
    "ai_generated": 1
  },
  "topFixes": [
    {
      "checkId": "CKV_AZURE_59",
      "resourceType": "azurerm_storage_account",
      "timesUsed": 5,
      "successRate": 0.8
    }
  ]
}
```

---

### 3. Get Top Fixes

**GET** `/api/users/me/fix-preferences/top`

Returns the most frequently used fixes for the authenticated user, ordered by usage count.

| Query Param | Type   | Default | Description                  |
|-------------|--------|---------|------------------------------|
| `limit`     | number | 10      | Number of top fixes to return |

**Response 200:**
```json
{
  "topFixes": [ /* array of UserFixPreference */ ],
  "count": 3
}
```

---

### 4. Search Preferences

**GET** `/api/users/me/fix-preferences/search`

Searches the authenticated user's preferences by check ID pattern (case-insensitive).

| Query Param | Type   | Required | Default | Description                    |
|-------------|--------|----------|---------|--------------------------------|
| `q`         | string | Yes      | —       | Search term (e.g., `CKV_AZURE`) |
| `limit`     | number | No       | 20      | Max results                    |

**Response 200:**
```json
{
  "results": [ /* matching preferences */ ],
  "count": 2,
  "query": "CKV_AZURE"
}
```

**Response 400** (missing query):
```json
{ "error": "Query parameter \"q\" is required" }
```

---

### 5. Get Specific Preference

**GET** `/api/users/me/fix-preferences/:checkId/:resourceType`

Returns a specific preference identified by Checkov check ID and Terraform resource type.

| Path Param     | Description                              |
|----------------|------------------------------------------|
| `checkId`      | Checkov check ID (e.g., `CKV_AZURE_59`)  |
| `resourceType` | Terraform resource type (e.g., `azurerm_storage_account`) |

**Response 200:** Single `UserFixPreference` object.

**Response 404:**
```json
{
  "error": "Preference not found",
  "checkId": "CKV_AZURE_59",
  "resourceType": "azurerm_storage_account"
}
```

---

### 6. Get Fixes for Check (Public)

**GET** `/api/fix-preferences/check/:checkId/:resourceType`

Returns all fixes for a specific check across all users. Does not require authentication (optional auth).

| Path Param     | Description                              |
|----------------|------------------------------------------|
| `checkId`      | Checkov check ID                         |
| `resourceType` | Terraform resource type                  |
| `limit`        | Query param, default 20                  |

**Response 200:**
```json
{
  "fixes": [ /* array of UserFixPreference */ ],
  "count": 3,
  "checkId": "CKV_AZURE_59",
  "resourceType": "azurerm_storage_account"
}
```

---

### 7. Create Preference

**POST** `/api/users/me/fix-preferences`

Creates a new fix preference for the authenticated user. If a preference already exists for the same `checkId` + `resourceType`, it updates the existing one instead.

**Request Body:**
```json
{
  "checkId": "CKV_AZURE_59",
  "resourceType": "azurerm_storage_account",
  "fixSnippet": "allow_nested_items_to_be_public = false",
  "confidence": 0.95,
  "source": "user_verified",
  "timesUsed": 0,
  "successCount": 0,
  "failureCount": 0
}
```

| Field          | Type   | Required | Constraints                                           |
|----------------|--------|----------|-------------------------------------------------------|
| `checkId`      | string | Yes      | —                                                     |
| `resourceType` | string | Yes      | —                                                     |
| `fixSnippet`   | string | Yes      | The Terraform fix code                                |
| `confidence`   | number | Yes      | 0.0 – 1.0                                            |
| `source`       | string | Yes      | `user_verified`, `checkov`, `ai_generated`, `user_preference` |
| `timesUsed`    | number | Yes      | Non-negative integer                                  |
| `successCount` | number | Yes      | Non-negative integer                                  |
| `failureCount` | number | Yes      | Non-negative integer                                  |

**Response 201:** Created `UserFixPreference` object.

**Response 400** (validation error):
```json
{
  "error": "Validation failed",
  "details": [ /* Zod validation issues */ ]
}
```

---

### 8. Update Preference

**PUT** `/api/users/me/fix-preferences/:id`

Updates an existing preference. Only the authenticated user who owns the preference can update it.

| Path Param | Description              |
|------------|--------------------------|
| `id`       | Preference UUID          |

**Request Body** (all fields optional):
```json
{
  "fixSnippet": "updated_fix = true",
  "confidence": 0.99,
  "source": "user_verified"
}
```

| Field        | Type   | Constraints                                           |
|--------------|--------|-------------------------------------------------------|
| `fixSnippet` | string | —                                                     |
| `confidence` | number | 0.0 – 1.0                                            |
| `source`     | string | `user_verified`, `checkov`, `ai_generated`, `user_preference` |

**Response 200:** Updated `UserFixPreference` object.

**Response 404:** Preference not found or not owned by user.

---

### 9. Track Usage

**POST** `/api/users/me/fix-preferences/:id/use`

Records a usage event for a preference. Increments `timesUsed` and either `successCount` or `failureCount`. Also adjusts the confidence score automatically:
- **Success:** confidence += 0.05 (max 1.0)
- **Failure:** confidence -= 0.1 (min 0.0)

| Path Param | Description              |
|------------|--------------------------|
| `id`       | Preference UUID          |

**Request Body:**
```json
{ "success": true }
```

| Field     | Type    | Required | Description                      |
|-----------|---------|----------|----------------------------------|
| `success` | boolean | Yes      | Whether the fix was applied successfully |

**Response 200:** Updated `UserFixPreference` object with incremented counters and adjusted confidence.

**Response 400:** Missing `success` field.
**Response 404:** Preference not found or not owned by user.

---

### 10. Delete Preference

**DELETE** `/api/users/me/fix-preferences/:id`

Deletes a specific preference. Only the owner can delete it.

| Path Param | Description              |
|------------|--------------------------|
| `id`       | Preference UUID          |

**Response 200:**
```json
{ "success": true, "message": "Preference deleted" }
```

**Response 404:** Preference not found or not owned by user.

---

### 11. Delete All Preferences

**DELETE** `/api/users/me/fix-preferences`

Deletes all preferences for the authenticated user.

**Response 200:**
```json
{
  "success": true,
  "message": "Deleted 3 preference(s)",
  "count": 3
}
```

---

### 12. Get Low Confidence Preferences

**GET** `/api/users/me/fix-preferences/low-confidence`

Returns preferences with confidence scores below a threshold. Useful for identifying candidates for cleanup.

| Query Param  | Type   | Default | Description                         |
|--------------|--------|---------|-------------------------------------|
| `threshold`  | number | 0.3     | Confidence threshold (exclusive)    |

**Response 200:**
```json
{
  "preferences": [ /* low confidence preferences */ ],
  "count": 2,
  "threshold": 0.3
}
```

---

### 13. Cleanup Low Confidence Preferences

**POST** `/api/users/me/fix-preferences/cleanup`

Bulk deletes all preferences below a confidence threshold.

**Request Body:**
```json
{ "threshold": 0.3 }
```

| Field       | Type   | Default | Description                     |
|-------------|--------|---------|---------------------------------|
| `threshold` | number | 0.3     | Delete preferences below this   |

**Response 200:**
```json
{
  "success": true,
  "message": "Cleaned up 1 low confidence preference(s)",
  "count": 1,
  "threshold": 0.3
}
```

---

## Confidence Score System

The confidence score (0.0 – 1.0) is a self-learning metric that tracks how reliable each fix is:

| Event         | Adjustment | Description                              |
|---------------|------------|------------------------------------------|
| Initial set   | User-defined | Set at creation time                   |
| Successful use | +0.05     | Fix applied successfully (max 1.0)       |
| Failed use    | -0.10      | Fix application failed (min 0.0)         |

Low-confidence fixes (typically < 0.3) are candidates for automatic cleanup.

---

## Source Types

| Source            | Description                                      |
|-------------------|--------------------------------------------------|
| `user_verified`   | Manually verified by the user                    |
| `checkov`         | Sourced from Checkov remediation docs            |
| `ai_generated`    | Generated by the AI system                       |
| `user_preference` | Derived from user's past preferences             |

---

## Error Responses

| Status | When                                          |
|--------|-----------------------------------------------|
| 400    | Validation failed or missing required fields  |
| 401    | Missing or invalid authentication token       |
| 404    | Resource not found or not owned by user        |
| 500    | Internal server error                         |

---

## Quick Start Example

```bash
# 1. Sign up and get token
TOKEN=$(curl -s -X POST http://localhost:9005/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"username":"myuser","email":"me@example.com","password":"MyPass123!"}' \
  | jq -r '.token')

# 2. Create a fix preference
curl -X POST http://localhost:9005/api/users/me/fix-preferences \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "checkId": "CKV_AZURE_59",
    "resourceType": "azurerm_storage_account",
    "fixSnippet": "allow_nested_items_to_be_public = false",
    "confidence": 0.95,
    "source": "user_verified",
    "timesUsed": 0,
    "successCount": 0,
    "failureCount": 0
  }'

# 3. Track usage (success)
curl -X POST http://localhost:9005/api/users/me/fix-preferences/<id>/use \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"success": true}'

# 4. Get statistics
curl http://localhost:9005/api/users/me/fix-preferences/stats \
  -H "Authorization: Bearer $TOKEN"
```
