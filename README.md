# AMP HTTP MCP Server

An MCP server for the CubeCoders AMP HTTP API.

AMP exposes a machine-readable API catalog through `Core/GetAPISpec`. This server provides a friendly MCP layer for common AMP operations such as listing instances, selecting a server, starting/stopping it, reading/writing files, and sending console commands. It also keeps a raw `amp_call` escape hatch for advanced API methods.

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

Copy the example environment file and fill it in if your MCP client does not inject environment variables itself:

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

If you run this from Codex, you can put the same values under `[mcp_servers.amp.env]` in `C:\Users\User\.codex\config.toml` instead of creating a repo-local `.env`. In that setup `.env` may not exist, and that is fine.

## MCP Config

```json
{
  "mcpServers": {
    "amp": {
      "command": "node",
      "args": ["C:\\path\\to\\amp-http-mcp-server\\dist\\server.js"],
      "env": {
        "AMP_BASE_URL": "https://amp.example.com",
        "AMP_USERNAME": "amp-automation-user",
        "AMP_PASSWORD": "change-me",
        "AMP_POLICY_ENABLED": "true",
        "AMP_POLICY_GROUP": "AI"
      }
    }
  }
}
```

You can also provide `AMP_SESSION_ID`, but `amp_login` or `amp_login_from_env` is usually cleaner because the server stores the session in memory and redacts it from tool output.

## Tools

Friendly day-to-day tools:

- `amp_connection_status`: show non-secret connection and policy status
- `amp_instances`: list instances in the configured policy group
- `amp_status`: show status for one instance, the selected instance, or all allowed instances
- `amp_use_instance`: select an instance by name, friendly name, or ID
- `amp_start_instance`: start an allowed instance
- `amp_stop_instance`: stop an allowed instance
- `amp_restart_instance`: restart an allowed instance, or start it if it is stopped
- `amp_files_list`: list a directory through AMP File Manager
- `amp_file_read`: read a file through AMP File Manager
- `amp_file_write`: overwrite a file through AMP File Manager
- `amp_file_append`: append to a file through AMP File Manager
- `amp_file_rename`: rename a file through AMP File Manager
- `amp_file_copy`: copy a file into another directory
- `amp_file_trash`: move a file to AMP trash
- `amp_directory_create`: create a directory
- `amp_directory_rename`: rename a directory
- `amp_directory_trash`: move a directory to AMP trash
- `amp_console_read`: read recent console/status updates from the selected instance
- `amp_console_send`: send console input to the selected instance
- `amp_supported_apps`: list AMP application modules available for new instances
- `amp_create_instance`: create a new auto-configured instance in the policy group

Setup and escape-hatch tools:

- `amp_configure`: set base URL, optional session ID, and policy options
- `amp_api_spec`: view the bundled spec or refresh live from AMP
- `amp_module_info`: call `Core/GetModuleInfo`
- `amp_policy_instances`: list instances currently allowed by the MCP policy group
- `amp_auth_requirements`: call `Core/GetAuthenticationRequirements`
- `amp_login`: call `Core/Login` with explicit credentials
- `amp_login_from_env`: call `Core/Login` using environment or `.env` credentials
- `amp_clear_session`: forget stored controller and managed-instance sessions
- `amp_call`: call any method in the loaded AMP API spec

State-changing calls through `amp_call` require `confirm: true`.

## Friendly Workflows

List the instances the MCP is allowed to touch:

```json
{}
```

with `amp_instances`.

Select one by a unique partial name:

```json
{
  "instance": "my-server",
  "startIfStopped": true
}
```

with `amp_use_instance`.

List a folder:

```json
{
  "path": "."
}
```

with `amp_files_list`.

Read a file:

```json
{
  "path": "config/server.cfg"
}
```

with `amp_file_read`.

Write a file:

```json
{
  "path": "notes/Example.txt",
  "content": "Hello from AMP MCP\n"
}
```

with `amp_file_write`.

Move a file to trash:

```json
{
  "path": "notes/OldExample.txt"
}
```

with `amp_file_trash`.

Send a console command:

```json
{
  "message": "status"
}
```

with `amp_console_send`.

The file and console tools default to `startIfStopped: true` because AMP's managed instance APIs usually need the instance to be running before File Manager and console calls work. Pass `startIfStopped: false` when you only want to operate on already-running instances.

To create a new instance, first inspect modules with `amp_supported_apps`, then call `amp_create_instance`:

```json
{
  "module": "Minecraft",
  "friendlyName": "AI Test Server",
  "autoConfigure": true
}
```

The MCP policy forces created instances into `AMP_POLICY_GROUP`.

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
- Friendly tools resolve instance names only from the policy group. If a name matches multiple instances, the tool refuses to guess.
- Managed instance login is retried for a short period after start/restart so clients can use simple one-step flows.

This policy is a guardrail in this MCP server. It is not a replacement for AMP permissions. You should still use least-privilege AMP roles because anyone with direct API access can bypass this wrapper.

## File Manager Warning

AMP's `FileManager.FileManager.*` permissions are broad permission nodes. Depending on how your AMP deployment is structured, granting file-manager permissions may allow browsing files in the current AMP instance context.

For safer operation:

- avoid giving the automation account FileManager permissions unless it truly needs them
- use a dedicated display group and keep `AMP_POLICY_ENABLED=true`
- do not expose this MCP server to untrusted clients
- rotate the automation password/session if you accidentally run it with an administrator account
- keep `.env`, HAR files, `dist`, and `node_modules` out of Git

## Refreshing The API Spec

The bundled `src/amp-api-spec.json` is only a fallback. After login, call:

```json
{
  "refresh": true
}
```

with `amp_api_spec` to load the live methods exposed by your AMP server, modules, and extensions.
