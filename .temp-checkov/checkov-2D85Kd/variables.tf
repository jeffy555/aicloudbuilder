variable "resource_group_name" {
  description = "The name of the resource group"
  type        = string
}

variable "location" {
  description = "The Azure location for the resources"
  type        = string
}

variable "storage_account_name" {
  description = "The name of the storage account"
  type        = string
}

variable "app_service_plan_name" {
  description = "The name of the App Service Plan"
  type        = string
}

variable "function_app_name" {
  description = "The name of the Function App"
  type        = string
}

variable "runtime_stack" {
  description = "The runtime stack for the Function App"
  type        = string
}

variable "functions_worker_runtime" {
  description = "The worker runtime for Azure Functions"
  type        = string
}

variable "acr_name" {
  description = "The name of the Azure Container Registry"
  type        = string
}

variable "acr_sku" {
  description = "The SKU of the Azure Container Registry"
  type        = string
  default     = "Basic"
}

variable "container_app_env_name" {
  description = "The name of the Azure Container App Environment"
  type        = string
}

variable "geo_replication_location" {
  type        = string
  description = "The location for geo-replication of the storage account."
}