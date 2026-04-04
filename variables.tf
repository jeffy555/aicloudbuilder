variable "container_registry_name" {
  description = "The name of the container registry."
  type        = string
  default     = "spiritops"
}

variable "container_registry_sku" {
  description = "The SKU of the container registry."
  type        = string
  default     = "Basic"
}

variable "dns_zone_name" {
  description = "The name of the DNS zone."
  type        = string
  default     = "spiritops.in"
}

variable "dns_zone_location" {
  description = "The location of the DNS zone."
  type        = string
  default     = "global"
}

variable "log_analytics_workspace_name" {
  description = "The name of the Log Analytics workspace."
  type        = string
  default     = "workspaceaicloudbuilder9db5"
}

variable "managed_environment_name" {
  description = "The name of the managed environment."
  type        = string
  default     = "spiritops-container-app-env"
}

variable "managed_certificate_name" {
  description = "The name of the managed certificate."
  type        = string
  default     = "www.spiritops.in-spiritop-260227063125"
}

variable "container_app_name" {
  description = "The name of the container app."
  type        = string
  default     = "spiritops-app"
}

variable "location" {
  description = "The Azure region where resources will be created."
  type        = string
  default     = "southindia"
}
