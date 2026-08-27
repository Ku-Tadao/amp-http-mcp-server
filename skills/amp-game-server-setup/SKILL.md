---
name: amp-game-server-setup
description: Set up a game server on an AMP (CubeCoders) panel through the AMP MCP tools, interviewing the user for the settings that matter and handling AMP's ordering traps. Use this whenever someone wants a new game server created, deployed, provisioned or "spun up" on AMP - Minecraft, Valheim, Necesse, Palworld, Rust, Terraria, Satisfactory, ARK, any of them - and also when they ask to configure, reconfigure or fix the settings of a server that already exists there. Trigger on phrases like "make me a Minecraft server", "set up another Necesse server", "add a modded server", "create an AMP instance", "change my server's difficulty/MOTD/slots", even when AMP is never named, as long as AMP MCP tools are available.
---

# Setting up a game server on AMP

AMP will happily accept a create call and then silently ignore half of what you sent it. Most of
this skill is about the order things have to happen in, and about asking the user the handful of
questions that actually change the outcome.

## Before the interview

Two checks, because both change what you can promise:

1. `amp_status` — confirms the MCP is connected and shows what already exists.
2. `amp_permissions` — the account is often not a super admin.

Look specifically at whether game settings are writable. If they are not, say so **before** the
interview rather than collecting a MOTD you cannot apply:

> Heads up: this AMP account can create and run servers but can't write their settings, so I'll get
> the server up on template defaults and you'll need to set the MOTD and password in the web UI (or
> have an admin grant the role `Settings.Meta.GenericModule`). Want me to carry on?

Permissions for game settings are **instance-scoped**, so once an instance exists, ask about that
instance: `amp_permissions` with `instance: "<name>"`. The controller's list genuinely does not
include them, and answering from it produces confident false negatives.

## Basic or advanced

Ask which depth they want, and make the difference concrete rather than abstract:

> Do you want the **basic** setup (name, MOTD, ports, difficulty/gamemode, mods — I pick sensible
> defaults for everything else) or **advanced** (all of the above plus slots, world seed, PvP,
> whitelist, view distance, backups, memory limits, sleep-when-empty)?

Then interview. Ask in small batches, not one enormous wall of questions — two or three at a time
reads like a conversation instead of a form.

**Every value is skippable, and say so up front.** People often don't care about half of these.
When someone skips, you have two moves and should pick deliberately:

- **Auto-fill** when there is an obviously good answer: ports, slots, difficulty, MOTD derived from
  the server name. Tell them what you chose.
- **Leave unset** when guessing would be wrong or unsafe: server password, owner/admin name, world
  seed. Inventing a password the user doesn't know is worse than leaving the server open, and
  inventing an owner name silently gives admin to nobody.

Never invent a value in the second category to avoid an awkward gap. Report it instead.

## What to ask, by depth

Both tiers, every game:

| Question | If skipped |
| --- | --- |
| Server name (the panel's display name) | Derive from the game and a number: "Minecraft #2" |
| MOTD / description shown to players | Reuse the server name |
| Ports | **Auto-pick — see below.** Always report what you chose |
| Server password | Leave empty, and warn the port is open to anyone who finds it |
| Admin/owner name | Leave unset, and say nobody has admin until they set it |
| Modded? Which loader/modpack? | Vanilla |

Advanced adds: player slots, difficulty and gamemode specifics, PvP, whitelist, world seed and type,
view/simulation distance, memory limits, backup policy, sleep-when-empty, auto-start on boot.

Per-game settings, their exact AMP config nodes, and sensible defaults live in `references/`:

- `references/minecraft.md` — the `MinecraftModule` family (difficulty, gamemode, Forge/Fabric/Paper, seeds)
- `references/generic-games.md` — the `GenericModule` template family, which covers Necesse, Valheim,
  Palworld, Terraria and most SteamCMD titles

Read the one that matches. If the game is in neither, `Core/GetSettingsSpec` on the running instance
lists every node it actually has, which beats guessing.

## Picking ports

Ask whether they have a range that's port-forwarded. If they don't know, or say "just pick one",
choose for them:

1. `amp_call ADSModule/GetLocalInstances` (controller scope) — this lists **every** instance,
   including ones the current session can't otherwise see, so it's the only reliable view of what's
   taken. `amp_instances` alone will miss some.
2. Collect every `ApplicationEndpoints` port and every `Port` field.
3. Pick the lowest free pair in their range, or next to the same game's existing servers so related
   servers cluster together.
4. Say which ports you took, and remind them these need forwarding in the router/firewall.

## Creating the server

The order below is not stylistic — each step exists because the previous one makes it possible.

**1. Create, always auto-configured.**

```
amp_create_instance  module=<module>  applicationId=<id from amp_supported_apps>
                     friendlyName=<name>  autoConfigure=true  postCreate=DoNothing
```

`autoConfigure: false` produces a standalone instance with its own local admin account that the MCP
can never log into, and no amount of repair fixes it — it has to be deleted. Wanting particular
ports is not a reason to pass `false`; ports get moved in step 2.

Creation is slow. If the result carries `taskTimedOut`, the instance almost certainly exists and is
still provisioning — **do not create it again**. Check `amp_instances`.

**2. Move the ports.**

```
amp_call ADSModule/GetInstanceNetworkInfo  {"InstanceName": "<name>"}
amp_call ADSModule/SetInstanceNetworkInfo  {"InstanceId": "<guid>",
          "PortMappings": {"<ProvisionNodeName>": <port>, ...}, "mustStop": true}
```

The `PortMappings` keys are the `ProvisionNodeName` values the first call returns, e.g.
`GenericModule.App.Ports.$GamePort` or `MinecraftModule.Minecraft.PortNumber`, plus
`FileManagerPlugin.SFTP.SFTPPortNumber`. `ApplyInstanceConfiguration` accepts port arguments and
silently drops them, so don't reach for it.

**3. Install the game.** `amp_use_instance`, then `amp_call Core/UpdateApplication` (managed scope).
This is a SteamCMD or Java download and takes minutes. Poll `Core/GetTasks` or `amp_console_read`.

**4. Now apply settings.** Not before. An app's settings nodes come from its config manifest, which
does not exist until the app is installed — `Meta.GenericModule.world` answers `No such node` on a
fresh Necesse instance until the update has run.

```
amp_call Core/SetConfig  {"node": "Meta.GenericModule.motd", "value": "..."}
```

Use `Core/SetConfig` one node at a time rather than `SetConfigs`. The plural form answers a refused
write with a bare `false` and no reason, which reads like success.

**5. Start and verify.** `amp_call Core/Start`, then `amp_console_read` until the game reports it is
listening. Confirm the game port shows `Listening: true` — a running AMP instance whose game port is
closed is not a working server.

## Handling refusals

**A settings write is denied.** The permission node for a setting is the setting's own node prefixed
with `Settings.`, so `Meta.GenericModule.world` needs `Settings.Meta.GenericModule.world`, and the
parent `Settings.Meta.GenericModule` covers the group. These nodes exist only inside the instance
that runs the game, never on the ADS controller, which is why they can't be found in the controller's
Role Management page. Options, in order of preference:

1. An admin ticks the group in a **template role**, which then applies to every instance of that
   game automatically. This is the right fix for "every new server needs this again". Template roles
   need AMP's Advanced edition and are web-UI only.
2. `amp_grant_app_settings` does it through the API, if the account holds
   `Core.RoleManagement.EditRolePermissions`.
3. The user sets those values in the web UI themselves.

Editing the config file through the file manager is **not** a workaround. AMP holds exclusive control
of files like `server.cfg` and rewrites them from its own config store on every app start, so the
edit silently reverts.

After any permission change, call `amp_clear_session` — permissions are read at login.

**Something fails for a reason that doesn't match what you just did** — "instance is not available",
"requires the Session.Exists permission", "Unknown AMP method" for a method that obviously exists, an
instance missing from `amp_instances`. That's a stale session. `amp_clear_session`, then retry.

## Reporting back

Close with what they need to actually play and what's still open. Something like:

> **Minecraft #2** is up on `:25566`, Paper 1.21, normal difficulty, survival, 10 slots, whitelist off.
>
> - Ports 25566 (game) and 25567 (SFTP) — these need forwarding on your router.
> - No server password set, so anyone who finds the port can join.
> - No operator set yet — tell me your in-game name and I'll set it.

Always call out the values you auto-filled and the ones you left unset, so nothing you chose on
their behalf is a surprise later.
