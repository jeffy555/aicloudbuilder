# 🚀 Local Development Setup Guide

This guide will help you set up the AI-Driven DevOps Platform on your local machine.

## 📋 Prerequisites

### Required Tools
- **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- **npm** or **yarn** - Comes with Node.js
- **Azure CLI** - [Install Guide](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- **Git** - [Download](https://git-scm.com/)

### Required Accounts
- **OpenAI Account** - For AI-powered Terraform generation
- **GitHub Account** - For repository integration
- **Azure DevOps Account** (optional) - If using Azure DevOps provider
- **Azure Account** - For backend provisioning

---

## 🔧 Step 1: Clone the Repository

```bash
git clone <your-repo-url>
cd <repo-directory>
```

---

## 📦 Step 2: Install Dependencies

```bash
npm install
```

---

## 🔑 Step 3: Configure Environment Variables

### 3.1 Create .env file

```bash
cp .env.example .env
```

### 3.2 Fill in Required Values

Edit `.env` and add your credentials:

#### **OpenAI API Key** (Required)
1. Go to [OpenAI Platform](https://platform.openai.com/api-keys)
2. Create a new API key
3. Copy and paste into `.env`:
   ```
   OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

#### **GitHub Token** (Required for GitHub integration)
1. Go to [GitHub Settings → Developer Settings → Personal Access Tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Select scopes: `repo`, `read:org`, `read:user`
4. Copy token and add to `.env`:
   ```
   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   GITHUB_OWNER=your-github-username
   ```

#### **Azure DevOps PAT** (Optional - only if using Azure DevOps)
1. Go to Azure DevOps → User Settings → Personal Access Tokens
2. Create new token with scopes: `Code (Read & Write)`, `Project and Team (Read)`
3. Add to `.env`:
   ```
   AZURE_DEVOPS_ORG=your-org-name
   AZURE_DEVOPS_PROJECT=your-project-name
   AZURE_DEVOPS_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   AZURE_DEVOPS_USER_ID=your-user-id
   ```

#### **Azure Authentication** (Required for Azure backend features)

You have **two options** for Azure authentication:

##### **Option A: Service Principal** (Recommended for production)
Create a Service Principal in Azure and add to `.env`:
```
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

**To create Service Principal:**
```bash
az login
az ad sp create-for-rbac --name "aicloudbuilder-sp" --role contributor --scopes /subscriptions/{SUBSCRIPTION_ID}
```

**No `az login` required after setup!** ✅

See [AZURE_AUTHENTICATION.md](./AZURE_AUTHENTICATION.md) for detailed instructions.

##### **Option B: Azure CLI** (For local development)
Simply login with Azure CLI:
```bash
az login
az account show  # Verify authentication
```

**Note:** If Service Principal credentials are provided, they take precedence over Azure CLI.

#### **Session Secret** (Required)
Generate a random secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env`:
```
SESSION_SECRET=<generated-secret>
```

---

## ☁️ Step 4: Azure Authentication (If using Azure features)

### Option A: Service Principal (Recommended)

See [AZURE_AUTHENTICATION.md](./AZURE_AUTHENTICATION.md) for complete setup instructions.

**Quick setup:**
1. Create Service Principal: `az ad sp create-for-rbac --name "aicloudbuilder-sp" --role contributor`
2. Add credentials to `.env` file
3. No `az login` needed!

### Option B: Azure CLI (Local Development)

```bash
az login
az account show  # Verify
```

**Note:** Service Principal takes precedence if both are configured.

---

## 🎯 Step 5: Start the Application

### Development Mode (with hot reload)

```bash
npm run dev
```

The application will start on **http://localhost:5000**

### What Happens When You Start:
1. **Backend server** starts on port 5000
2. **Frontend** (Vite dev server) is served through the backend
3. **MCP servers** are spawned as child processes:
   - GitHub MCP server (for repository operations)
   - Azure DevOps MCP server (if credentials provided)
   - Azure Resources MCP server (for Azure resource management)

---

## ✅ Step 6: Verify Setup

### 6.1 Open the Application
Navigate to: **http://localhost:5000**

### 6.2 Test Provider Connections

**Test GitHub:**
1. Select "GitHub" as provider
2. Click "Next"
3. You should see your repositories listed

**Test Azure:**
1. Ensure `az login` was successful
2. The Azure backend provisioning will use your Azure CLI session

---

## 🐛 Troubleshooting

### Issue: "OpenAI API Error"
- **Solution**: Verify `OPENAI_API_KEY` is correct
- Check you have credits in your OpenAI account

### Issue: "GitHub repositories not loading"
- **Solution**: Verify `GITHUB_TOKEN` has correct scopes
- Check `GITHUB_OWNER` matches your username/org

### Issue: "Azure resource creation fails"
- **Solution**: Run `az login` again
- Verify you have permissions to create resources
- Check subscription is set correctly: `az account show`

### Issue: "Azure MCP server not starting"
- **Solution**: Install Azure CLI if not installed
- Run `az --version` to verify installation
- Ensure you're logged in: `az account show`

### Issue: "Port 5000 already in use"
- **Solution**: Kill the process using port 5000:
  ```bash
  # On macOS/Linux
  lsof -ti:5000 | xargs kill -9
  
  # On Windows
  netstat -ano | findstr :5000
  taskkill /PID <PID> /F
  ```

---

## 🔒 Security Best Practices

1. **Never commit `.env` file** - It's already in `.gitignore`
2. **Rotate secrets regularly** - Especially API keys and PATs
3. **Use least-privilege access** - Only grant required permissions
4. **Keep dependencies updated** - Run `npm audit` regularly

---

## 📚 Additional Resources

- [Azure CLI Documentation](https://learn.microsoft.com/en-us/cli/azure/)
- [GitHub PAT Documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token)
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)

---

## 🆘 Need Help?

If you encounter issues not covered here:
1. Check the console logs for error messages
2. Verify all environment variables are set correctly
3. Ensure all prerequisite tools are installed
4. Check that Azure CLI authentication is active

---

## 🎉 You're Ready!

Once everything is set up, you can:
✅ Generate Terraform configurations using AI  
✅ Commit code to GitHub or Azure DevOps  
✅ Provision Azure backend resources automatically  
✅ Validate existing Terraform configurations  

Happy DevOps automation! 🚀
