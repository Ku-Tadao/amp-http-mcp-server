# AMP HTTP MCP Server

An MCP server for the CubeCoders AMP HTTP API.

AMP exposes a machine-readable API catalog through `Core/GetAPISpec`. This server provides a friendly MCP layer for common AMP operations such as listing instances, selecting a server, starting/stopping it, reading/writing files, and sending console commands. It also keeps a raw `amp_call` escape hatch for advanced API methods.

Built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). It serves both protocol
eras over stdio: clients that open with `initialize` negotiate the 2025 revision, and clients
that send a 2026-07-28 `_meta` envelope get the current revision. No client-side change needed.

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
AMP_POLICY_LOCKED=true
AMP_PROTECTED_INSTANCES=
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
        "AMP_POLICY_GROUP": "AI",
        "AMP_POLICY_LOCKED": "true",
        "AMP_PROTECTED_INSTANCES": "instance-id-or-name,another-instance-id-or-name"
      }
    }
  }
}
```

You can also provide `AMP_SESSION_ID`, but `amp_login` or `amp_login_from_env` is usually cleaner because the server stores the session in memory and redacts it from tool output.

## Codex Skill

This repo includes a Codex skill at `.agents/skills/amp-mcp`. It teaches Codex how to use the friendly AMP MCP tools, diagnose missing environment/policy setup, avoid treating `amp_api_spec` as a raw AMP module, and keep operations inside the configured policy group.

When working inside this repository, Codex can discover the repo-scoped skill automatically. To make it available globally on your machine, copy or install `.agents/skills/amp-mcp` into:

```text
%USERPROFILE%\.agents\skills\amp-mcp
```

Restart Codex after installing a new global skill.

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

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) so clients can decide what to auto-run and what to confirm. Eight tools are
marked read-only; ten are marked destructive, including `amp_stop_instance`, `amp_file_write`,
`amp_file_trash`, `amp_console_send`, and `amp_call`.

Note that the instance-scoped read tools (`amp_files_list`, `amp_file_read`, `amp_console_read`)
are deliberately **not** marked read-only: they default to `startIfStopped: true` and will power
on a stopped instance. Pass `startIfStopped: false` to keep them side-effect free.

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

For a GenericModule application, pass its `Id` from `amp_supported_apps` as `applicationId`;
the tool loads the catalogued module settings automatically instead of requiring a large
`provisionSettings` object.

The MCP policy forces created instances into `AMP_POLICY_GROUP`.

## Safety Model

Do not run this with a full administrator account for day-to-day use.

Recommended setup:

1. Create a dedicated AMP user for automation.
2. Create a dedicated AMP role for that user.
3. Grant only the AMP permissions needed for the instances you want the MCP client to operate.
4. Put those instances in a dedicated AMP display group, for example `AI`.
5. Grant the automation user `Instances.<instanceId>.Manage` on each of those instances.
6. Set `AMP_POLICY_ENABLED=true` and `AMP_POLICY_GROUP=AI`.

Step 5 is the one that is easy to miss. `ADSModule/GetInstances` returns only the instances the
user has an explicit Manage grant on, so without it the display group reads as empty and every
instance tool refuses, even though AMP's web panel shows the servers. `amp_policy_instances`
detects this and names the affected instances in its `warning`. Treat the permission list
returned by `Core/Login` as authoritative rather than the role names shown in the panel.

When the MCP policy is enabled:

- Supported ADS create calls are forced into `Group` matching `AMP_POLICY_GROUP`.
- Existing-instance ADS calls are blocked unless the target instance is currently in that display group.
- Policy and base-URL changes are locked at runtime unless `AMP_POLICY_LOCKED=false` is set before launch.
- Controller-wide and aggregate state-changing raw calls are blocked because they cannot be scoped to one display group.
- State-changing calls against IDs/names in `AMP_PROTECTED_INSTANCES` are blocked; read-only calls remain available.
- After `ADSModule/ManageInstance`, instance module calls such as `FileManagerPlugin/*` are routed through AMP's controller proxy path: `/API/ADSModule/Servers/{instanceId}/API/{Module}/{Method}`.
- File-manager calls are blocked unless the managed AMP instance is in the policy group.
- Friendly tools resolve instance names only from the policy group. If a name matches multiple instances, the tool refuses to guess.
- Managed instance login is retried for a short period after start/restart so clients can use simple one-step flows.

This policy is a guardrail in this MCP server. It is not a replacement for AMP permissions. You should still use least-privilege AMP roles because anyone with direct API access can bypass this wrapper.

## What The Automation Account Can And Cannot Do

Least privilege has a sharp edge worth knowing before an agent hits it mid-task: the grants that
let the account run a server are separate from the grants that let it configure one. A typical
non-super-admin automation role can create instances, move their ports, install and update the
game, start and stop it, read the console and use the file manager — and still be unable to change
a single game setting.

| Action | Permission node | Usually granted? |
| --- | --- | --- |
| Create an instance | `ADS.InstanceManagement.CreateInstance` | yes |
| Change instance ports (`ADSModule/SetInstanceNetworkInfo`) | `ADS.InstanceManagement.Reconfigure` | yes |
| Install/update the game (`Core/UpdateApplication`) | `Core.AppManagement.UpdateApplication` | yes |
| Start/stop the app | `Core.AppManagement.*` | yes |
| **Write instance settings (`Core/SetConfig`, `Core/SetConfigs`)** | **`Settings.*`** | **often not** |
| Delete an instance | `ADS.InstanceManagement.DeleteInstances` | rarely |
| Read user/role info | `Core.UserManagement.ViewUserInfo` | rarely |

The `Settings.*` gap is the one that bites. It means a freshly created server runs on its template
defaults and the values an operator actually cares about — server password, admin/owner name, world
name, MOTD, slot count — have to be set from the AMP web UI by a super admin. `Core/SetConfigs`
signals this badly: it returns a bare `false` rather than an error, so this server converts that
into a real failure that names the likely cause and tells you to retry with `Core/SetConfig`, which
does report AMP's reason.

To check a node before depending on it, rather than discovering the gap halfway through:

```bash
amp_call Core/CurrentSessionHasPermission {"PermissionNode": "Settings.GenericModule.Meta.*"}
```

Permission denials raised through `amp_call` carry a `[permissions]` hint naming the node to grant.
Granting is a super-admin action in AMP's Configuration > Role Management.

## Creating Instances

Always create with `autoConfigure: true` (the default). AMP builds an `autoConfigure: false`
instance in standalone management mode with its own local admin account, which the controller
credentials cannot log into — every managed call then fails with `Core/Login returned no session
ID`, and `ADSModule/ReactivateInstance` does not repair it. The instance has to be deleted from the
web UI.

Wanting specific ports is not a reason to pass `false`. Create the instance auto-configured, then
move its ports:

```bash
amp_call ADSModule/GetInstanceNetworkInfo {"InstanceName": "Necesse03"}
amp_call ADSModule/SetInstanceNetworkInfo {"InstanceId": "<guid>", "PortMappings": {"GenericModule.App.Ports.$GamePort": 50004, "FileManagerPlugin.SFTP.SFTPPortNumber": 50005}, "mustStop": true}
```

The `PortMappings` keys are the `ProvisionNodeName` values from `GetInstanceNetworkInfo`. Note that
`ADSModule/ApplyInstanceConfiguration` accepts port arguments and silently does not apply them —
use `SetInstanceNetworkInfo`.

## Stale Sessions

AMP decides which instances a session can see, and what its API spec contains, when that session
logs in. A session opened before something changed keeps reporting the old world. This surfaces as
errors that have nothing to do with what you just did:

- `The requested instance is not available at this time`
- `You do not have permission ... requires the Session.Exists permission`
- `Unknown AMP method "Core/GetStatus"` for a method that plainly exists
- an instance missing from `amp_status` that `ADSModule/GetLocalInstances` shows
- a login cooldown after a single transient error

`amp_clear_session` fixes all of them. It drops the session, cached specs, selection and cooldowns
while keeping credentials, so the next call logs in again. `amp_create_instance` now does this
automatically, since the session that created an instance cannot see it.

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

The server also refreshes the authenticated controller catalog immediately after login and refuses
to replace it with AMP's much smaller anonymous discovery catalog. On the audited deployment,
the live AMP 2.8.0.4 catalog exactly matches the fallback: 7 modules and 205 methods. AMP's actual
interactive API browser is `/api`; `/apiNote` is the normal panel shell, not API documentation.

The controller spec does not list an application instance's own modules. After selecting an
instance with `amp_use_instance`, pass:

```json
{
  "fromManagedInstance": true
}
```

to read that instance's own spec (`MinecraftModule`, `GenericModule`, and so on). `amp_call`
resolves against the selected instance's spec automatically, so those application methods are
callable once an instance is selected.

Use `scope: "controller"` or `scope: "managed"` with `amp_call` when a module such as `Core`
exists at both levels. The default `scope: "auto"` keeps the convenient selected-instance routing.

## Authentication retry safety

Rejected controller and managed-instance logins use an exponential cooldown: 60 seconds after
the first rejection, doubling up to 15 minutes. Configure the bounds with
`AMP_AUTH_RETRY_BASE_MS` and `AMP_AUTH_RETRY_MAX_MS`. Network failures are retried normally;
only authentication rejections and HTTP 401/403/429 responses advance the cooldown. A successful
login resets it. After correcting credentials, `amp_clear_session` also resets the cooldown.

## Transport scope

This executable is stdio-only and keeps AMP connection/session state for the life of its single
process. The fresh `McpServer` factory exists for stdio protocol-version fallback; it does not make
AMP state safe for multiple HTTP clients. Any future Streamable HTTP entry point must create AMP
state per MCP session and clean it up when that session closes.
