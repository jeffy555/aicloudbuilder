output "container_registry_id" {
  value = azurerm_container_registry.spiritops.id
}

output "dns_zone_id" {
  value = azurerm_dns_zone.spiritops_in.id
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.workspaceaicloudbuilder9db5.id
}

output "managed_environment_id" {
  value = azurerm_app_managed_environment.spiritops_container_app_env.id
}

output "managed_certificate_id" {
  value = azurerm_app_managed_certificate.spiritops_managed_certificate.id
}

output "container_app_id" {
  value = azurerm_container_app.spiritops_app.id
}
