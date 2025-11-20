# 🔐 Azure Authentication Guide

## Overview

The Azure MCP Server supports **9 different authentication methods**! You can use:

### **No CLI Login Required:**
1. ✅ **Service Principal with Client Secret** (Most common)
2. ✅ **Service Principal with Certificate** (More secure)
3. ✅ **Workload Identity Federation** (GitHub Actions, Kubernetes)
4. ✅ **Managed Identity** (If running on Azure)
5. ✅ **Visual Studio/VS Code** (If signed in)

### **Requires CLI/Tool Login:**
6. **Azure CLI** (`az login`)
7. **Azure PowerShell** (`Connect-AzAccount`)
8. **Azure Developer CLI** (`azd auth login`)
9. **Interactive Browser** (Fallback)

The Azure MCP Server uses `DefaultAzureCredential` which automatically tries authentication methods in this order:
1. Environment variables (Service Principal)
2. Managed Identity (if running on Azure)
3. Visual Studio credentials
4. Azure CLI (if logged in)
5. Azure PowerShell (if logged in)
6. Azure Developer CLI (if logged in)
7. Interactive Browser (fallback)

**See [AZURE_AUTH_OPTIONS.md](./AZURE_AUTH_OPTIONS.md) for complete details on all 9 methods!**

---

## 🔑 Option 1: Service Principal (Recommended)

**Best for:** Production environments, CI/CD pipelines, automated deployments

**No CLI login required!** ✅

### Step 1: Create Service Principal in Azure

```bash
# Login to Azure CLI (one-time setup)
az login

# Create Service Principal with Contributor role
az ad sp create-for-rbac --name "aicloudbuilder-sp" --role contributor --scopes /subscriptions/{SUBSCRIPTION_ID}

# Output will look like:
# {
#   "appId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",  # This is AZURE_CLIENT_ID
#   "displayName": "aicloudbuilder-sp",
#   "password": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",    # This is AZURE_CLIENT_SECRET
#   "tenant": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # This is AZURE_TENANT_ID
# }
```

**Or via Azure Portal:**
1. Go to **Azure Portal** → **Azure Active Directory** → **App registrations**
2. Click **New registration**
3. Name: `aicloudbuilder-sp`
4. Click **Register**
5. Note the **Application (client) ID** → This is `AZURE_CLIENT_ID`
6. Note the **Directory (tenant) ID** → This is `AZURE_TENANT_ID`
7. Go to **Certificates & secrets** → **New client secret**
8. Create secret and **copy the value immediately** → This is `AZURE_CLIENT_SECRET`
9. Go to **Subscriptions** → Select your subscription → **Access control (IAM)**
10. Click **Add** → **Add role assignment**
11. Role: **Contributor** (or **Storage Account Contributor** + **Resource Group Contributor**)
12. Assign access to: **User, group, or service principal**
13. Select your service principal: `aicloudbuilder-sp`

### Step 2: Get Subscription ID

```bash
az account show --query id -o tsv
```

Or from Azure Portal:
- Go to **Subscriptions** → Copy the **Subscription ID**

### Step 3: Add to .env file

Add these variables to your `.env` file:

```env
# Azure Service Principal (Alternative to CLI login)
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Step 4: Verify Authentication

The application will automatically detect Service Principal credentials and use them. You'll see in the logs:
```
Using Service Principal authentication for Azure MCP
```

**No `az login` required!** ✅

---

## 🔧 Option 2: Azure CLI (Local Development)

**Best for:** Local development, quick testing

**Requires:** `az login` ✅

### Step 1: Install Azure CLI

**Windows:**
```powershell
# Download and install from:
# https://aka.ms/installazurecliwindows

# Or via winget
winget install -e --id Microsoft.AzureCLI
```

**macOS:**
```bash
brew install azure-cli
```

**Linux:**
```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

### Step 2: Login

```bash
az login
```

This will open your browser for authentication.

### Step 3: Verify Login

```bash
az account show
```

You should see your subscription details.

### Step 4: Set Default Subscription (if multiple)

```bash
# List subscriptions
az account list --output table

# Set default
az account set --subscription "<subscription-id>"
```

### Step 5: Verify Permissions

Ensure your account has permissions to:
- Create Resource Groups
- Create Storage Accounts
- Create Blob Containers

Required roles:
- **Contributor** (full access), OR
- **Storage Account Contributor** + **Resource Group Contributor**

---

## 🎯 Which Method to Use?

### Use Service Principal When:
- ✅ Running in production
- ✅ Using CI/CD pipelines
- ✅ Need automated deployments
- ✅ Don't want to manage CLI sessions
- ✅ Multiple users/environments

### Use Azure CLI When:
- ✅ Local development
- ✅ Quick testing
- ✅ Personal projects
- ✅ Interactive development

---

## 🔒 Security Best Practices

### Service Principal:
1. **Store secrets securely:**
   - Use Azure Key Vault in production
   - Never commit `.env` file to git
   - Use environment variables in CI/CD

2. **Use least privilege:**
   - Grant only necessary permissions
   - Use specific resource scopes when possible
   - Rotate secrets regularly

3. **Monitor usage:**
   - Review Service Principal activity in Azure Portal
   - Set up alerts for unusual activity

### Azure CLI:
1. **Logout when done:**
   ```bash
   az logout
   ```

2. **Use separate accounts:**
   - Use personal account for development
   - Use service account for production

---

## 🐛 Troubleshooting

### Service Principal Issues

**Error: "Authentication failed"**
- Verify `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` are correct
- Check Service Principal hasn't been deleted
- Verify secret hasn't expired (create new one if needed)

**Error: "Insufficient permissions"**
- Verify Service Principal has **Contributor** role
- Check role assignment is at subscription or resource group level
- Wait a few minutes after role assignment (propagation delay)

**Error: "Subscription not found"**
- Verify `AZURE_SUBSCRIPTION_ID` is correct
- Check Service Principal has access to the subscription

### Azure CLI Issues

**Error: "Please run 'az login'"**
- Run `az login` to authenticate
- Verify with `az account show`

**Error: "No subscriptions found"**
- Your account might not have access to any subscriptions
- Contact Azure administrator to grant access

**Error: "Insufficient permissions"**
- Your account needs **Contributor** role
- Contact Azure administrator to grant permissions

---

## 📝 Environment Variables Reference

### Service Principal (All Required Together)
```env
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### Azure CLI (Optional - for fallback)
```env
# If using Azure CLI, you can optionally set subscription
AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

## ✅ Verification

### Check Authentication Method

When the server starts, check the logs:
- **Service Principal:** `Using Service Principal authentication for Azure MCP`
- **Azure CLI:** `Using Azure CLI authentication (az login required)`

### Test Azure MCP Connection

The Azure MCP server will automatically connect when you:
1. Select Azure as cloud provider
2. Configure backend (Step 5)
3. Create/validate Azure resources

If authentication fails, you'll see error messages in the console.

---

## 🚀 Quick Start

### For Production (Service Principal):
```bash
# 1. Create Service Principal
az ad sp create-for-rbac --name "aicloudbuilder-sp" --role contributor

# 2. Add to .env
AZURE_CLIENT_ID=<appId>
AZURE_CLIENT_SECRET=<password>
AZURE_TENANT_ID=<tenant>
AZURE_SUBSCRIPTION_ID=<subscription-id>

# 3. Start server - No az login needed!
npm run dev
```

### For Development (Azure CLI):
```bash
# 1. Login
az login

# 2. Verify
az account show

# 3. Start server
npm run dev
```

---

## 📚 Additional Resources

- [Azure Service Principal Documentation](https://learn.microsoft.com/en-us/azure/active-directory/develop/app-objects-and-service-principals)
- [Azure CLI Authentication](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli)
- [DefaultAzureCredential](https://learn.microsoft.com/en-us/dotnet/api/azure.identity.defaultazurecredential)
- [Azure MCP Server](https://github.com/Azure/azure-mcp)

---

**Note:** The code automatically detects which authentication method to use. If Service Principal credentials are provided, it uses those. Otherwise, it falls back to Azure CLI.

