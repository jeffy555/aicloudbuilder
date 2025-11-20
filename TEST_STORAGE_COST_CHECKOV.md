# Test Report: Storage Account, Cost Analysis & Checkov Scan

**Date:** 19/11/2025, 9:24:47 pm
**Repository:** https://github.com/jeffy555/my-repo-jeff
**Session ID:** dc6ea8d6-c1ec-4067-98ab-7fc518e6523d

---

## 📁 Repository Scan

- **Cloud Provider:** azure
- **Module Type:** root
- **Files Found:** 7

### Files:

1. `backend.tf`
2. `dev.terraform.tfvars`
3. `main.tf`
4. `outputs.tf`
5. `provider.tf`
6. `terraform.tf`
7. `variables.tf`

## 🔧 Storage Account Generation

**Request:** "Add a storage account with Standard tier and LRS replication"

**Files Generated/Updated:** 0

*Note: Files may have been updated in session storage.*

## 💰 Cost Analysis Results (AI-Driven)

### Cost Summary

- **Total Monthly Cost:** $6.00
- **Total Yearly Cost:** $72.02
- **Currency:** USD
- **Resources Analyzed:** 2

### Cost Breakdown by Resource

1. **function_storage**
   - **Type:** `azurerm_storage_account`
   - **Service:** Storage Accounts
   - **Monthly Cost:** $6.00

2. **function_app**
   - **Type:** `azurerm_function_app`
   - **Service:** Functions
   - **Monthly Cost:** $0.00

## 🔍 Checkov Security Scan Results

### Summary

- **Total Checks:** 44
- **Passed:** 12 ✅
- **Failed:** 32 ❌
- **Skipped:** 0
- **Pass Rate:** 27.0%

### Failed Checks (32)

1. **CKV_AZURE_59**: Ensure that Storage accounts disallow public access
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/ensure-that-storage-accounts-disallow-public-access

2. **CKV_AZURE_33**: Ensure Storage logging is enabled for Queue service for read, write and delete requests
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-logging-policies/enable-requests-on-storage-logging-for-queue-service

3. **CKV_AZURE_206**: Ensure that Storage Accounts use replication
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-206

4. **CKV_AZURE_190**: Ensure that Storage blobs restrict public access
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/azr-networking-190

5. **CKV_AZURE_67**: Ensure that 'HTTP Version' is the latest, if used to run the Function app
   - **Resource:** `azurerm_function_app.function_app`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/ensure-that-http-version-is-the-latest-if-used-to-run-the-function-app

6. **CKV_AZURE_70**: Ensure that Function apps is only accessible over HTTPS
   - **Resource:** `azurerm_function_app.function_app`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/ensure-that-function-apps-is-only-accessible-over-https

7. **CKV_AZURE_56**: Ensure that function apps enables Authentication
   - **Resource:** `azurerm_function_app.function_app`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/ensure-that-function-apps-enables-authentication

8. **CKV_AZURE_163**: Enable vulnerability scanning for container images.
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-163

9. **CKV_AZURE_237**: Ensure dedicated data endpoints are enabled.
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-237

10. **CKV_AZURE_166**: Ensure container image quarantine, scan, and mark images verified
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-166

11. **CKV_AZURE_167**: Ensure a retention policy is set to cleanup untagged manifests.
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-167

12. **CKV_AZURE_233**: Ensure Azure Container Registry (ACR) is zone redundant
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-233

13. **CKV_AZURE_165**: Ensure geo-replicated container registries to match multi-region container deployments.
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/azr-networking-165

14. **CKV_AZURE_139**: Ensure ACR set to disable public networking
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/ensure-azure-acr-is-set-to-disable-public-networking

15. **CKV_AZURE_164**: Ensures that ACR uses signed/trusted images
   - **Resource:** `azurerm_container_registry.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-164

16. **CKV_AZURE_59**: Ensure that Storage accounts disallow public access
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/ensure-that-storage-accounts-disallow-public-access

17. **CKV_AZURE_33**: Ensure Storage logging is enabled for Queue service for read, write and delete requests
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-logging-policies/enable-requests-on-storage-logging-for-queue-service

18. **CKV_AZURE_44**: Ensure Storage Account is using the latest version of TLS encryption
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-storage-policies/bc-azr-storage-2

19. **CKV_AZURE_206**: Ensure that Storage Accounts use replication
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/azr-general-206

20. **CKV_AZURE_190**: Ensure that Storage blobs restrict public access
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-networking-policies/azr-networking-190

21. **CKV2_AZURE_40**: Ensure storage account is not configured with Shared Key authorization
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-40

22. **CKV2_AZURE_40**: Ensure storage account is not configured with Shared Key authorization
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-40

23. **CKV2_AZURE_47**: Ensure storage account is configured without blob anonymous access
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-47

24. **CKV2_AZURE_47**: Ensure storage account is configured without blob anonymous access
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-47

25. **CKV2_AZURE_33**: Ensure storage account is configured with private endpoint
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-2-33

26. **CKV2_AZURE_33**: Ensure storage account is configured with private endpoint
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-2-33

27. **CKV2_AZURE_41**: Ensure storage account is configured with SAS expiration policy
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-41

28. **CKV2_AZURE_41**: Ensure storage account is configured with SAS expiration policy
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-iam-policies/bc-azure-2-41

29. **CKV2_AZURE_38**: Ensure soft-delete is enabled on Azure storage account
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-2-38

30. **CKV2_AZURE_38**: Ensure soft-delete is enabled on Azure storage account
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/bc-azure-2-38

31. **CKV2_AZURE_1**: Ensure storage for critical data are encrypted with Customer Managed Key
   - **Resource:** `azurerm_storage_account.function_storage`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/ensure-storage-for-critical-data-are-encrypted-with-customer-managed-key

32. **CKV2_AZURE_1**: Ensure storage for critical data are encrypted with Customer Managed Key
   - **Resource:** `azurerm_storage_account.example`
   - **File:** `\main.tf`
   - **Guideline:** https://docs.prismacloud.io/en/enterprise-edition/policy-reference/azure-policies/azure-general-policies/ensure-storage-for-critical-data-are-encrypted-with-customer-managed-key


---

## 📊 Test Summary

✅ All steps completed successfully!

1. ✅ Repository scanned
2. ✅ Storage account added
3. ✅ Cost analysis completed (AI-driven)
4. ✅ Checkov security scan completed

