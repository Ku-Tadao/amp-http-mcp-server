---
name: amp-game-server-setup
description: Create and configure game servers on an AMP (CubeCoders) panel through the AMP MCP tools, interviewing the user for the decisions that actually matter and respecting the order AMP requires. Use this whenever someone wants a game server created, deployed, provisioned or "spun up" on AMP - Minecraft, Valheim, Necesse, Palworld, Rust, Terraria, ARK, any of the 240-odd apps it supports - and equally when they want an existing server reconfigured: difficulty, MOTD, slots, whitelist, passwords, mods. Trigger on "make me a Minecraft server", "set up another Necesse server", "add a modded server", "change my server's difficulty", "why won't my server let me set X", even when AMP is never named, as long as AMP MCP tools are available.
---

# Game servers on AMP

An app's settings do not exist until the app is installed. `Meta.GenericModule.world` answers
`No such node` on a Necesse instance that was created ten seconds ago, and no amount of passing
values to `amp_create_instance` changes that — AMP takes them and drops them.

That single fact shapes everything here. You cannot interview someone about their server and then
build it. You build a shell, install the game, and only then does the server become a thing with
settings to discuss. So the work splits in two.

## Phase 1 — enough to create the shell

Four things, and only these, before anything exists:

- **Which game.** `amp_supported_apps` gives the application ID. Necessary for everything else.
- **A name.** Theirs, or derived from the game and a number.
- **Ports.** See below — usually you decide these, not them.
- **Depth.** Basic or advanced, which only changes how much of phase 2 you ask about.

Do not ask about difficulty, MOTD, passwords or mods yet. You cannot apply the answers, and asking
for values you will have to ask about again later is worse than waiting.

**Ports are your job, not theirs.** Ask only whether they have a forwarded range. Then:
`amp_call ADSModule/GetLocalInstances` (controller scope) lists *every* instance including ones the
session cannot otherwise see — `amp_instances` will miss some and you will collide with a port that
looked free. Take every `ApplicationEndpoints` port and every `Port`, pick the lowest free pair in
their range, and tell them what you took and that it needs forwarding.

The same principle covers the whole skill: anything discoverable from the panel is yours to find.
Available versions, whether an app is installed, what ports are taken, which permissions the account
holds — look them up. Only decisions belong to the user.

## Build the shell

Order matters; each step is what makes the next possible.

1. **`amp_create_instance` with `autoConfigure: true`.** Always. `false` produces a standalone
   instance with its own local admin account that this MCP can never log into, and nothing repairs
   it — it has to be deleted. Wanting specific ports is not a reason; ports move in step 2.
   Creation is slow, and a `taskTimedOut` in the result means it is still provisioning, **not** that
   it failed. Never create it a second time.
2. **Move the ports.** `ADSModule/GetInstanceNetworkInfo` gives the `ProvisionNodeName` keys; feed
   them to `ADSModule/SetInstanceNetworkInfo` with `mustStop: true`.
   `ApplyInstanceConfiguration` accepts port arguments and silently ignores them.
3. **Install.** `amp_use_instance`, then `Core/UpdateApplication`. Minutes, not seconds — watch
   `Core/GetTasks` or `amp_console_read`.

Now the server has settings.

## Phase 2 — interview from what the instance actually has

`Core/GetSettingsSpec` on the running instance returns every setting the app has, each with its
display name, description, current value, type, enum options and whether it is required. That is the
question list, generated from the app in front of you rather than a table someone wrote for a
different version of a different game. Use it. There are 240 apps and they change.

Rank what comes back by **consequence**, because that determines both what to ask in basic mode and
what a skip means:

**Class 1 — access and authority.** Server password, whitelist, owner/admin name. Who can get in and
who is in charge.

**Class 2 — irreversible or world-defining.** World name or level name, seed, hardcore mode. Changing
a world name later loads or creates a *different world*; on a server people have played, that reads
as "our world is gone".

**Class 3 — how it plays.** Difficulty, gamemode, PvP, slots, MOTD, mods.

**Class 4 — housekeeping.** View distance, memory, backups, sleep-when-empty, idle timeouts.

Basic asks classes 1–3. Advanced walks all four. Group questions by class rather than firing them
one at a time — people answer "difficulty, gamemode, PvP?" in one breath and resent three separate
messages. Show the current value so they can say "fine" without thinking.

### Skipping

Say up front that anything can be skipped. What a skip *means* depends on the class:

- **Classes 3 and 4: auto-fill.** There is an obviously reasonable answer. Take it, and say what you
  took.
- **Classes 1 and 2: leave unset, and report it.** Never invent these. A password the user does not
  know is worse than an open port, because they believe it is secured and cannot get in themselves.
  An invented owner name grants admin to nobody while looking done. A guessed seed is a world they
  did not choose.

The failure mode to avoid is a tidy-looking summary that quietly hides a decision nobody made.

### Writing the values

`Core/SetConfig`, one node at a time. `SetConfigs` answers a refused write with a bare `false` and no
reason, which reads exactly like success.

Then start it — `Core/Start` — and confirm from `amp_console_read` that the game reports listening
and the game port shows `Listening: true`. A running AMP instance with a closed game port is not a
working server.

## Reconfiguring a server that already exists

Phase 2 on its own. Select the instance, read `GetSettingsSpec`, ask about what they raised plus
anything in class 1 or 2 that is still unset, write, restart if the setting needs it.

Check `amp_permissions` with the instance name first. Game-settings permissions are **instance
scoped**: the controller's list genuinely omits them, so asking the controller produces confident
false negatives about settings the account can in fact write.

## When a write is refused

A setting's permission node is its own node prefixed with `Settings.` —
`Meta.GenericModule.world` needs `Settings.Meta.GenericModule.world`, and the parent
`Settings.Meta.GenericModule` covers the group. These nodes exist only inside the instance running
the game, never on the ADS controller, which is why they cannot be found in the controller's Role
Management page and why people conclude they do not exist.

Best fix first: an admin ticks the group in a **template role**, which then applies to every instance
of that game automatically — the right answer to "every new server needs this again", though it needs
AMP's Advanced edition and is web-UI only. Otherwise `amp_grant_app_settings` does it through the
API, or the user sets those values themselves in the panel.

Editing the config file through the file manager is **not** a workaround. AMP holds exclusive control
of files like `server.cfg` and rewrites them from its own store on every app start, so the edit
reverts silently.

After any permission change, `amp_clear_session` — permissions are read at login.

## When something fails for no reason that fits

"Instance is not available", "requires the Session.Exists permission", `Unknown AMP method` for a
method that obviously exists, an instance missing from `amp_instances` that you just created. These
are one bug wearing different masks: a session's visible instances and API spec are fixed at login.
`amp_clear_session`, then retry, before investigating anything else.

## Closing

Report what they need in order to play, then every value you chose for them and every one you left
unset. Those two lists are the point — a summary that omits them is how someone discovers three weeks
later that their server never had a password.

`references/game-notes.md` holds the handful of per-game judgments a settings spec cannot express,
such as Minecraft's EULA and which games hide a destructive change behind an innocuous-looking field.
Read it when the game is listed there.
