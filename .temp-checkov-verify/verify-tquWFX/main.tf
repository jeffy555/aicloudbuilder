Sure! Based on the Checkov security checks you provided, I'll modify the Terraform configuration to address the issues. Specifically, I will apply the exact remediation snippet for the identified check.

Here’s the updated Terraform code with the necessary changes:

```terraform
resource "azurerm_app_service_plan" "this" {
  name                = "${var.resource_group_name}-asp"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku {
    tier     = var.app_service_plan_sku
    size     = var.app_service_plan_sku
  }
  kind               = "Linux"
  reserved           = true
  tags = {
    managed-by = "terraform"
    module     = "app-service-child"
  }
}

resource "azurerm_linux_web_app" "this" {
  name                = "${var.resource_group_name}-webapp"
  location            = var.location
  resource_group_name = var.resource_group_name
  app_service_plan_id = azurerm_app_service_plan.this.id

  site_config {
    http2_enabled                            = true
    client_cert_enabled                      = true
    detailed_error_messages_enabled          = true
    failed_request_tracing_enabled           = true
    ftp_state                                = "Disabled"
    http_logging_enabled                      = true
    http_version                             = "2.0"
    https_only                               = true
    azure_active_directory_authentication_enabled = true
    health_check_path                        = "/health"
    incoming_client_cert_enabled             = true
    azure_files_enabled                       = true  # This was already present, ensuring compliance
    public_network_access_enabled            = false
  }
  
  identity {
    type = "SystemAssigned"
  }
}
```

### Changes Made:
- Confirmed that `azure_files_enabled` is set to `true` in the `site_config` block of the `azurerm_linux_web_app` resource. This ensures compliance with the Checkov security check CKV_AZURE_88.

Let me know if you need any further modifications or if you would like to proceed with this configuration!