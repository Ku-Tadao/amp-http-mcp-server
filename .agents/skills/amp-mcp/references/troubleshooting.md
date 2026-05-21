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
