# AMP HTTP MCP Server

An MCP server for the CubeCoders AMP HTTP API.

AMP exposes a machine-readable API catalog through `Core/GetAPISpec`. This server uses that catalog shape to provide a small, generic MCP bridge for logging in, discovering available methods, and calling AMP API methods from an MCP client.

## How AMP Calls Work

AMP API calls are made with:

```text
POST /API/{Module}/{Method}
```

Requests use JSON bodies. Authenticated calls include the current session in two places:

```http
Authorization: Bearer {SESSIONID}
```

```json
{
  "SESSIONID": "{SESSIONID}"
}
```

`Core/Login` returns the session ID. `Core/GetAPISpec` returns the available modules, methods, parameters, return types, and required permissions for the target AMP instance.

## Install

```powershell
npm install
npm run build
npm test
```

Copy the example environment file and fill it in:

```powershell
Copy-Item .env.example .env
```

```dotenv
AMP_BASE_URL=https://amp.example.com
AMP_USERNAME=
AMP_PASSWORD=

# Optional 2FA one-time code/PIN for Core/Login. This is not the AMP session token.
AMP_TOKEN=
AMP_REMEMBER_ME=false

# MCP-side safety policy.
AMP_POLICY_ENABLED=true
AMP_POLICY_GROUP=AI
```

Then test login without printing credentials:

```powershell
npm run build
node dist/server.js --self-test-login
```

## MCP Config

```json
{
  "mcpServers": {
    "amp": {
      "command": "node",
      "args": ["C:\\path\\to\\amp-http-mcp-server\\dist\\server.js"],
      "env": {
        "AMP_BASE_URL": "https://amp.example.com"
      }
    }
  }
}
```

You can also provide `AMP_SESSION_ID`, but `amp_login` or `amp_login_from_env` is usually cleaner because the server stores the session in memory and redacts it from tool output.

## Tools

- `amp_configure`: set base URL, optional session ID, and policy options
- `amp_api_spec`: view the bundled spec or refresh live from AMP
- `amp_module_info`: call `Core/GetModuleInfo`
- `amp_policy_instances`: list instances currently allowed by the MCP policy group
- `amp_auth_requirements`: call `Core/GetAuthenticationRequirements`
- `amp_login`: call `Core/Login` with explicit credentials
- `amp_login_from_env`: call `Core/Login` using `.env` credentials
- `amp_clear_session`: forget the stored AMP session
- `amp_call`: call any method in the loaded AMP API spec

State-changing calls through `amp_call` require `confirm: true`.

## Safety Model

Do not run this with a full administrator account for day-to-day use.

Recommended setup:

1. Create a dedicated AMP user for automation.
2. Create a dedicated AMP role for that user.
3. Grant only the AMP permissions needed for the instances you want the MCP client to operate.
4. Put those instances in a dedicated AMP display group, for example `AI`.
5. Set `AMP_POLICY_ENABLED=true` and `AMP_POLICY_GROUP=AI`.

When the MCP policy is enabled:

- ADS create calls are forced into `Group` / `DisplayGroup` matching `AMP_POLICY_GROUP`.
- Existing-instance ADS calls are blocked unless the target instance is currently in that display group.
- After `ADSModule/ManageInstance`, instance module calls such as `FileManagerPlugin/*` are routed through AMP's controller proxy path: `/API/ADSModule/Servers/{instanceId}/API/{Module}/{Method}`.
- File-manager calls are blocked unless the managed AMP instance is in the policy group.

This policy is a guardrail in this MCP server. It is not a replacement for AMP permissions. You should still use least-privilege AMP roles because anyone with direct API access can bypass this wrapper.

## File Manager Warning

AMP's `FileManager.FileManager.*` permissions are broad permission nodes. Depending on how your AMP deployment is structured, granting file-manager permissions may allow browsing files in the current AMP instance context.

For safer operation:

- avoid giving the automation account FileManager permissions unless it truly needs them
- use a dedicated display group and keep `AMP_POLICY_ENABLED=true`
- do not expose this MCP server to untrusted clients
- rotate the automation password/session if you accidentally run it with an administrator account

## Refreshing The API Spec

The bundled `src/amp-api-spec.json` is only a fallback. After login, call:

```json
{
  "refresh": true
}
```

with `amp_api_spec` to load the live methods exposed by your AMP server and plugins.
