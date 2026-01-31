provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "function_rg" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_storage_account" "function_storage" {
  name                     = var.storage_account_name
  resource_group_name      = azurerm_resource_group.function_rg.name
  location                 = azurerm_resource_group.function_rg.location
  account_tier            = "Standard"
  account_replication_type = "GRS"  # Options: GRS, GZRS, RAGRS, ZRS
  min_tls_version         = "TLS1_2" // Ensure the latest version of TLS encryption
  allow_blob_public_access = false    // Disallow public access
  enable_https_traffic_only = true    // Ensure HTTPS is required for traffic
  logging {
    delete               = true
    read                 = true
    write                = true
    retention_policy {
      days = 7
    }
  }
}

resource "azurerm_app_service_plan" "function_plan" {
  name                = var.app_service_plan_name
  location            = azurerm_resource_group.function_rg.location
  resource_group_name = azurerm_resource_group.function_rg.name
  sku {
    tier     = "Dynamic"
    size     = "Y1"
  }
}

resource "azurerm_function_app" "function_app" {
  name                       = var.function_app_name
  location                   = azurerm_resource_group.function_rg.location
  resource_group_name        = azurerm_resource_group.function_rg.name
  storage_account_name       = azurerm_storage_account.function_storage.name
  app_service_plan_id        = azurerm_app_service_plan.function_plan.id
  version                    = "~3"
  os_type                    = "linux"
  runtime_stack              = var.runtime_stack

  app_settings = {
    "AzureWebJobsStorage" = azurerm_storage_account.function_storage.primary_connection_string
    "FUNCTIONS_WORKER_RUNTIME" = var.functions_worker_runtime
  }

  site_config {
    http2_enabled = true
  }
}

resource "azurerm_resource_group" "example" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_container_registry" "example" {
  name                = var.acr_name
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location
  sku                 = var.acr_sku
  admin_enabled       = false // Set admin_enabled to false for improved security
  georeplication {
    location = var.geo_replication_location // Add geo-replication for multi-region deployments
  }
  zone_redundant     = true // Ensure zone redundancy
}

resource "azurerm_container_app_environment" "example" {
  name                = var.container_app_env_name
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location
  ingress {
    external_enabled = true
    target_port      = 80
  }
}

resource "azurerm_logic_app_workflow" "example" {
  name                = var.logic_app_name
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location

  definition = jsonencode(
    {
      "$schema" = "http://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json"
      "triggers" = {
        "manual" = {
          "type" = "Request"
          "kind" = "Http"
          "inputs" = {
            "method" = "POST"
            "schema" = {
              "type" = "object"
              "properties" = {
                "exampleProperty" = {
                  "type" = "string"
                }
              }
            }
          }
        }
      }
      "actions" = {
        "response" = {
          "type" = "Response"
          "inputs" = {
            "statusCode" = 200
            "body" = {
              "message" = "Hello from Logic App!"
            }
          }
        }
      }
    }
  )

  access_control {
    role_assignment {
      principal_id   = var.principal_id
      role_definition_name = var.role_definition_name
    }
  }
}

resource "azurerm_logic_app_integration_account" "example" {
  name                = var.integration_account_name
  resource_group_name = azurerm_resource_group.example.name
  location            = azurerm_resource_group.example.location
}

resource "azurerm_logic_app_trigger_recurrence" "example" {
  workflow_name       = azurerm_logic_app_workflow.example.name
  resource_group_name = azurerm_resource_group.example.name
  frequency          = "Hour"
  interval           = 1
}