# AMP MCP Troubleshooting

Use this reference when AMP MCP tool results look contradictory, especially when a policy group appears empty.

## Empty Policy Group

`amp_policy_instances` or `amp_connection_status` returning zero instances can mean different things:

- The MCP process did not receive `AMP_BASE_URL` and credentials/session env.
- The MCP process is using the fallback base URL such as `https://amp.example.com`.
- The AMP user is authenticated but cannot see instances in `AMP_POLICY_GROUP`.
- Instances are not assigned to the expected AMP display group.
- The MCP client is attached to a different AMP MCP installation or stale build.

Check non-secret diagnostics before concluding that the live AMP server has no instances:

```json
{
  "baseUrl": "...",
  "hasUsername": true,
  "hasPassword": true,
  "policyEnabled": true,
  "policyGroup": "AI",
  "policyInstanceCount": 5
}
```

A repo-local `.env` may be absent intentionally. Codex can inject env through `~/.codex/config.toml` under `[mcp_servers.amp.env]`.

### Instances Exist In The Group But Are Not Listed

The most common cause, and the least obvious one. `ADSModule/GetInstances` only returns
instances the AMP user holds an explicit `Instances.<instanceId>.Manage` grant on. A display
group can contain instances while `GetInstances` returns none of them, so the policy group
looks empty even though AMP's web panel shows the servers.

Confirm it by comparing the two calls:

- `ADSModule/GetInstances` — permission-filtered, what the MCP policy uses.
- `ADSModule/GetLocalInstances` — every instance on the controller, unfiltered.

If `GetLocalInstances` shows instances in `AMP_POLICY_GROUP` that `GetInstances` omits, the
AMP user is missing the per-instance Manage grant. `amp_policy_instances` detects exactly this
case and names the affected instances in its `warning` field.

Fix it in AMP, not in this server: grant Manage on those instances to the automation user.
Adding a role such as `Super Admins` in the panel is not enough on its own — check the granted
permission list returned by `Core/Login`, which is authoritative. A user with a genuine
wildcard grant returns `*`; a scoped user returns explicit `Instances.<id>.Manage` entries.

Grants pointing at deleted instances linger in that list, so a user can appear to have several
Manage grants while none of them match a live instance.

## Wrong Raw API Usage

`amp_api_spec` is an MCP tool, not an AMP API module. Correct:

```text
call amp_api_spec directly
```

Incorrect:

```json
{
  "moduleName": "amp_api_spec",
  "methodName": "anything"
}
```

For raw AMP API calls, use actual AMP modules such as `ADSModule`, `Core`, or `FileManagerPlugin`.

## Stale Or Wrong Build

If `ADSModule/GetInstances` is reported as unknown even though the AMP MCP repo includes it:

1. Verify the MCP client points at the intended `dist/server.js`.
2. Rebuild the repo with `npm run build`.
3. Restart the MCP client so it launches the new `dist`.
4. Call `amp_api_spec` with `moduleName: "ADSModule"` to inspect the loaded spec.

## Managed Instance File Access

AMP instance File Manager calls should go through the friendly file tools. Internally these require a managed instance selected by `amp_use_instance` and may use AMP's ADS proxy path:

```text
/API/ADSModule/Servers/{instanceId}/API/{Module}/{Method}
```

If File Manager fails after starting an instance, retry after the instance reports running/idle. If the instance was originally stopped and only started for inspection, stop it again when done.

## Empty File Listings

AMP's file manager treats `""` as the instance root. Passing `"."` returns an empty list
rather than an error, so a wrong root looks like an empty instance instead of a failure.

The friendly file tools normalise this already. If you call the raw API through `amp_call`,
pass `Dir: ""` for the instance root:

```json
{
  "moduleName": "FileManagerPlugin",
  "methodName": "GetDirectoryListing",
  "params": { "Dir": "" }
}
```

`Dir: "/"` fails with an AMP array-bounds error, and `Dir: "."` silently returns nothing.

Note also that an instance reporting `Running: true` only means the AMP instance process is
up. The application inside it has its own state, readable through the instance-routed
`Core/GetStatus`. File access does not require the application to be started.

## AMP File Manager Quirks

Three behaviours in AMP's file manager fail quietly rather than returning an error. The
friendly file tools work around all three; they matter if you call the raw API via `amp_call`.

**`AppendFileChunk` does nothing.** It is declared `Void`, returns no `ActionResult`, and on
AMP 2.7.2 leaves the file unchanged whether `Data` is base64 or plain text. There is no
error to detect. `amp_file_append` therefore reads the file, concatenates, and rewrites it,
refusing when the file exceeds `AMP_MAX_READ_BYTES` rather than truncating it.

**`WriteFileChunk` recreates the file.** Writing at a non-zero `Offset` does not preserve
the existing bytes; it zero-fills everything before the offset. Offsets are only meaningful
within a single sequential write of the whole file.

**`RenameFile` resolves `NewFilename` relative to the source file's directory.** Passing a
full path double-prefixes it and fails:

```text
Could not find a part of the path '/AMP/necesse/1169370/mcp-rn/mcp-rn/b.txt'
```

Pass the bare new name. `RenameFile` also cannot move a file between directories: copy with
`CopyFile` and trash the original instead. `RenameDirectory` behaves the same way, taking
`NewDirectoryName` as a bare name.

