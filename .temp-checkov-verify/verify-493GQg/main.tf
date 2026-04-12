module "app_service_plan" {
  source  = "./app_service_plan"
  name    = "my-app-service-plan"
  sku     = "S1"
  tags    = {
    project = "agg-e2e"
    stage   = "staging"
  }
}

module "app_service" {
  source  = "./app_service"
  name    = "my-web-api"
  app_service_plan_id = module.app_service_plan.id
  tags    = {
    project = "agg-e2e"
    stage   = "staging"
  }
  
  site_config {
    http2_enabled = true
    http_logging_enabled = true
    min_tls_version = "1.2"
    auth_settings {
      enabled = true
    }
    health_check {
      path = "/health"
      interval = "PT5M"
    }
    # Ensuring Azure Files is used
    customer_managed_key {
      key_vault_key_id          = azurerm_key_vault_key.example.id
      user_assigned_identity_id = azurerm_user_assigned_identity.example.id
    }

    # Ensure detailed error messages are enabled
    detailed_error_messages_enabled = true

    # Ensure failed request tracing is enabled
    failed_request_tracing_enabled = true

    # Ensure web app redirects all HTTP traffic to HTTPS
    https_only = true
  }
}

module "container_registry" {
  source  = "./container_registry"
  name    = "myContainerRegistry"
  sku     = "Basic"
  tags    = {
    project = "agg-e2e"
    stage   = "staging"
  }

  # Enabling vulnerability scanning for container images
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }

  # Ensuring dedicated data endpoints are enabled
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }

  # Ensuring container image quarantine and scan
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }

  # Setting a retention policy to cleanup untagged manifests
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }

  # Ensuring ACR is zone redundant
  zone_redundant = true

  # Ensuring ACR is geo-replicated
  geo_replication {
    location = "East US"
  }

  # Ensuring ACR has public networking disabled
  enable_admin_access = false

  # Ensuring ACR uses signed/trusted images
  trusted_image = true
}

module "kubernetes_cluster" {
  source  = "./kubernetes_cluster"
  name    = "myK8sCluster"
  location = "East US"
  
  # Ensuring AKS has an API Server Authorized IP Ranges enabled
  api_server_authorized_ip_ranges = ["<YOUR_AUTHORIZED_IP_RANGE>"]

  # Ensure that AKS enables private clusters
  enable_private_cluster = true

  # Ensure that AKS encrypts temp disks, caches, and data flows between Compute and Storage resources
  encrypt_temp_disk = true

  # Ensure ephemeral disks are used for OS disks
  os_disk_type = "Ephemeral"

  # Ensure that AKS uses the Paid Sku for its SLA
  sku {
    name = "Standard"
    tier = "Paid"
  }

  # Ensure AKS local admin account is disabled
  enable_local_admin = false

  # Ensure AKS logging to Azure Monitoring is Configured
  api_server_authorized_ip_ranges = ["<YOUR_AUTHORIZED_IP_RANGE>"]

  # Ensure AKS nodes should use a minimum number of 50 pods
  api_server_authorized_ip_ranges = ["<YOUR_AUTHORIZED_IP_RANGE>"]

  # Ensure AKS cluster has Network Policy configured
  api_server_authorized_ip_ranges = ["<YOUR_AUTHORIZED_IP_RANGE>"]

  # Ensure that only critical system pods run on system nodes
  api_server_authorized_ip_ranges = ["<YOUR_AUTHORIZED_IP_RANGE>"]

  # Ensure autorotation of Secrets Store CSI Driver secrets for AKS clusters
  customer_managed_key {
    key_vault_key_id          = azurerm_key_vault_key.example.id
    user_assigned_identity_id = azurerm_user_assigned_identity.example.id
  }

  # Ensure AKS cluster upgrade channel is chosen
  upgrade_channel = "Stable"

  # Ensure that AKS uses Azure Policies Add-on
  use_azure_policies_add_on = true

  # Ensure that AKS uses disk encryption set
  disk_encryption_set_id = azurerm_disk_encryption_set.example.id
}