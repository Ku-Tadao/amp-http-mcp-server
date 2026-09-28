---
name: amp-mcp
description: "Operate, diagnose, or automate CubeCoders AMP through the AMP MCP server: connection/env/policy status, listing/selecting/starting/stopping/creating instances, File Manager and console tools, reading server files/configs/plugins, permissions, and raw AMP API calls through amp_call (choosing the method, exact parameter names, instance identifiers, confirm/scope, reading ActionResult/RunningTask results). Use whenever the task touches an AMP panel, an AMP-managed server, or AMP's /API endpoints, even if AMP is not named and the amp_* tools are available. Not for unrelated local-only code review."
---

# AMP MCP

Use the friendly `amp_*` tools first. `amp_call` is the escape hatch for AMP API methods no friendly
tool covers, and it is where most mistakes happen, so read "Raw API calls" before using it.

## First checks

1. Call `amp_connection_status` with `checkInstances: true` (or `amp_policy_instances` if unavailable).
2. Confirm `policyEnabled`, `policyGroup`, credential presence flags, and visible instance count before
   concluding AMP has no accessible instances.
3. A missing repo-local `.env` does not mean the MCP is unconfigured: the client may inject
   `AMP_BASE_URL`, `AMP_USERNAME`, `AMP_PASSWORD`, `AMP_TOKEN` and policy settings itself.

If the policy group is empty, or results contradict each other, read `references/troubleshooting.md`.

## Friendly tools

- Connection and auth: `amp_connection_status`, `amp_policy_instances`, `amp_module_info`,
  `amp_auth_requirements`, `amp_login`, `amp_login_from_env`, `amp_clear_session`, `amp_configure`.
- Permissions: `amp_permissions` (pass the instance name for instance-scoped nodes such as
  `Settings.*`), `amp_grant_app_settings`.
- Instances: `amp_instances`, `amp_status`, `amp_use_instance` (`{ "instance": "<name, friendly
  name, or GUID>" }`), `amp_start_instance`,
  `amp_stop_instance`, `amp_restart_instance`, `amp_supported_apps`, `amp_create_instance`.
- Files (selected instance): `amp_files_list`, `amp_file_read`, `amp_file_write`, `amp_file_append`,
  `amp_file_rename`, `amp_file_copy`, `amp_file_trash`, `amp_directory_create`,
  `amp_directory_rename`, `amp_directory_trash`.
- Console: `amp_console_read`, `amp_console_send`.
- Spec: `amp_api_spec` — an MCP tool, never a `moduleName` for `amp_call`.

Game-server creation and settings interviews have their own skill, `amp-game-server-setup`; use it
when the user wants a server built or reconfigured.

## Raw API calls

`references/api-reference.md` lists every controller method as one grep-able line: exact parameter
names and types, `?` for optional, return type, and required permission nodes. It was extracted from
a live AMP 2.8.0.4 panel. Grep it for the method before writing a call — AMP's naming is
inconsistent enough that guessing costs a failed round trip, or worse, a silent no-op.

```json
{ "moduleName": "ADSModule", "methodName": "GetInstances", "params": { "ForceIncludeSelf": true } }
```

### Parameter names are exact

`amp_call` builds the request from the spec's parameter names, matched case-sensitively. A wrong-cased
**required** parameter fails with `Missing required parameter`. A wrong-cased **optional** one is
dropped without any error, and the call runs with AMP's default: `mustStop`, `ForceIncludeSelf` and
`RestartIfPreviouslyRunning` are the ones that bite. Copy names from the reference.

### Identify the instance the way each method wants

The same instance is addressed four different ways, and a GUID where a name is expected (or the
reverse) fails as "instance not found":

| Parameter | Value | Methods (examples) |
|---|---|---|
| `InstanceName` | instance name, e.g. `Minecraft01` | `StartInstance`, `StopInstance`, `RestartInstance`, `DeleteInstance`, `UpgradeInstance`, `GetInstanceNetworkInfo`, `SetInstanceConfig`, `SetInstanceSuspended` |
| `InstanceId` | GUID | `GetInstance`, `SetInstanceNetworkInfo`, `ManageInstance` |
| `InstanceId` | GUID as a string | `UpdateInstanceInfo`, `RefreshInstanceConfig` |
| `instanceId` (lower-case) | GUID | `GetApplicationEndpoints`, `GetInstanceLiveSettings`, `ModifyCustomFirewallRule`, `MoveInstanceDatastore`, `PrepareFileTransfer`, `ReactivateInstance` |
| `InstanceID` | GUID | `ApplyInstanceConfiguration`, `ApplyTemplate` |

Take the name and GUID from `amp_instances` or `ADSModule/GetInstances` (`InstanceName`,
`InstanceID`), not from the friendly name.

Moving an instance's ports shows the mix in one task:

1. `ADSModule/GetInstanceNetworkInfo` with `InstanceName`. Each entry's `ProvisionNodeName` is a key
   for the next call.
2. `ADSModule/SetInstanceNetworkInfo` with the GUID as `InstanceId`,
   `PortMappings: { "<ProvisionNodeName>": <port>, … }` and `mustStop: true`. This updates the app's
   own port settings too; no separate `Core/SetConfig` is needed. `ApplyInstanceConfiguration`
   accepts port arguments and ignores them, so don't use it for ports.
3. The `mustStop` stop is asynchronous and leaves the instance stopped. Wait for
   `ADSModule/GetInstanceStatuses` to show `Running: false`, then `amp_start_instance`. Starting
   before the stop settles can return `alreadyRunning` and leave it stopped.

### Scope

`scope: "auto"` (the default) sends every non-`ADSModule` call to the selected instance when one is
selected, and to the controller otherwise. So `Core/GetStatus` after `amp_use_instance` describes
the game server, not the panel. Pass `scope: "controller"` or `"managed"` when it matters.

The reference covers the controller only. Game modules and instance plugins (`MinecraftModule`,
`GenericModule`, `LocalFileBackupPlugin`, …) exist only inside a running instance: select it, then
call `amp_api_spec` with `fromManagedInstance: true` (optionally `moduleName`).

### confirm

Any method whose name does not start with Get, List or Read needs `confirm: true` — setters, `Start`,
`UpdateApplication`, `SendConsoleMessage` all do. `ADSModule/GetTargetPairingCode` and
`Core/GetRemoteLoginToken` need it despite the prefix, because they mint credentials. Before
confirming, state what the call changes and on which instance.

### Reading the result

The return type says how to tell whether the call worked:

- **`ActionResult`** — `{ Status, Reason }`. The MCP raises an error when `Status` is false and
  includes AMP's reason.
- **`RunningTask`** — the work continues after the call returns (`DeployTemplate`, `CloneInstance`,
  `DeleteInstance`, `InstallStoreEntry`, datastore repairs). Poll `Core/GetTasks` on the same scope, or
  the state it changes, until it finishes. A timeout means still running, not failed; do not repeat
  the call.
- **`Void`** — no confirmation at all (`Core/Stop`, `Core/Kill`, `Core/SendConsoleMessage`,
  `FileManagerPlugin/AppendFileChunk`, `ADSModule/RefreshAppCache`). Verify by reading the state
  afterwards; `AppendFileChunk` in particular does nothing (see troubleshooting).
- **`Boolean`** from `Core/SetConfigs` — `false` means refused, with no reason. Use `Core/SetConfig`
  one node at a time to get the reason.

AMP reports failures with HTTP 200 and an error object, and the MCP turns them into tool errors. A
permission error names the missing node; `RequiredPermissions` in the reference names it up front. An
empty permission list is not "anyone may call this": setting reads and writes are filtered per
`Settings.<node>`, and those nodes live on the instance, not the controller.

### When the spec itself looks wrong

`Unknown AMP method` for a method in the reference, "Instance is not available", or a live
`amp_api_spec` holding only a dozen methods (the pre-login set listed in the reference) all mean the
session's spec was fixed at login and is stale or unauthenticated. `amp_clear_session`, then retry,
before investigating anything else.

## Safety

- Keep all operations inside the configured MCP policy group.
- Do not print passwords, tokens, session IDs, or admin credentials. HAR captures of the panel contain
  a session ID; keep them out of git and out of chat.
- If you start a stopped instance only to inspect files, stop it again before finishing unless the
  user asked otherwise.
- Read before writing, trashing, or deleting.
- Treat these as needing an explicit user yes, not only `confirm: true`: `DeleteInstance`,
  `DeleteInstanceUsers`, `Core/DeleteUser`, `Core/DeleteRole`, `Core/ResetUserPassword`,
  `FileManagerPlugin/EmptyTrash`, `StopAllInstances`, `UpgradeAllInstances`, `CloneInstance` with
  `DeleteSource: true`, `DetachTarget`, and anything under `Core.Special.*` (`RestartAMP`,
  `UpgradeAMP`, `UpdateAMPInstance`).

## File and plugin review

1. Select the instance with `amp_use_instance`.
2. List candidate folders with `amp_files_list` (the root is `""`).
3. Read the relevant files with `amp_file_read`.
4. Compare against any docs the user provided or local workspace docs.
5. Report only findings grounded in file paths, plugin names, and exact behavior.

Do not assume the game (Rust, Minecraft, …) unless the user says so or the instance metadata shows
it. For Oxide Rust review, read the user's `OxideRustDocumentation.txt` if present, then the
instance's Oxide plugin directory.

## Reporting

When blocked, give the exact MCP checks used and the non-secret facts they returned: tool
availability, `baseUrl`, credential presence flags, `policyGroup`, visible instance count, selected
instance, the method and parameters called, and AMP's error message. Do not conclude "AMP has no
instances" unless the credential and policy diagnostics support it.
