# Per-game judgments a settings spec cannot express

`Core/GetSettingsSpec` tells you every setting an app has, what it currently is, and what values are
legal. What it cannot tell you is which innocuous-looking field will destroy something, or which one
is a decision the user has to make personally. That is all this file is for.

Nothing here is a substitute for reading the spec. If a game is not listed, the spec is enough.

## Node families

Two shapes, worth recognising because the permission node follows the config node:

- **`MinecraftModule.<group>.<field>`** — Minecraft's purpose-built module. Groups: `Minecraft`
  (world/network), `Game` (gameplay), `Limits` (players, sleep), `Java` (memory).
- **`Meta.GenericModule.<field>`** — everything driven by a downloaded template, which is most of
  AMP's catalogue: Necesse, Valheim, Palworld, Terraria and the rest of the SteamCMD titles. Two
  fields use AMP placeholders rather than the game's own names: `$GamePort` and `$MaxUsers`.

## Minecraft

**The EULA is the user's decision, not yours.** A server will not start until Mojang's agreement is
accepted. `MinecraftModule.Minecraft.SkipEULACheck` exists, and accepting a licence on someone's
behalf is not yours to do. If the server will not start for this reason, say so and let them accept
it.

**Server type gates everything else.** Ask it before any other Minecraft question:
`Vanilla`, `Paper` (plugins, good performance, what most friends servers want), `Spigot`, `Forge`,
`NeoForge`, `Fabric`, `Purpur`, `Folia`, `Velocity`, `Sponge`. It decides whether mods are possible
at all, and which version field is live — `SpecificVersion`, `SpecificPaperVersion`,
`SpecificForgeVersion`, `FabricMCVersion` plus `FabricLoaderVersion`. Setting a version field that
does not match the chosen type silently does nothing.

**`LevelName` changes which world loads.** Destructive on a server with history.

**There is no server password.** `Whitelist` is the access control. If someone asks to password their
Minecraft server, that is what they mean.

**`HardcoreMode` is permanent death.** Confirm they mean it.

**Memory:** `Java.MaxHeapSizeMB` — 2–4 GB suits vanilla or Paper, 6–8 GB a large modpack. Check the
host has it: `ADSModule/GetInstances` reports free RAM under the target's `Fitness`.

**`PreventProxy` must stay off** for Velocity or BungeeCord setups, or legitimate players are refused.

## Necesse

**`Meta.GenericModule.world` changes which world loads.** Same trap as Minecraft's `LevelName`.

**`owner` is an exact name match** — the connecting player whose name matches gets owner rights, so a
typo silently grants admin to nobody.

**No difficulty or PvP setting exists.** If someone asks for "hard mode", that is a world-creation
choice inside the game, not a server setting. Say so rather than hunting for a node.

**`pauseWhenEmpty` is worth suggesting** on a host running several servers — it stops ticking a world
nobody is in.

## Steam Workshop mods (most GenericModule games)

`Settings.steamcmdplugin.SteamWorkshop.WorkshopItemIDs` holds the item IDs, and
`Core/UpdateApplication` downloads them into the instance's `workshop` directory. Several templates
then need each mod copied into a `mods` directory before the server will load it — the template's own
`Mods` setting description spells out the per-game step, so read it rather than assuming the download
was sufficient.

## Finding a template's field names

When you want the field list for a GenericModule game before it is installed, the templates are
public:

```bash
curl -sL https://raw.githubusercontent.com/CubeCoders/AMPTemplates/main/<game>config.json
```

Each entry's `FieldName` is the part after `Meta.GenericModule.`. Useful for planning; still no
substitute for `GetSettingsSpec` once the instance exists, since that reports what this instance
actually has.
