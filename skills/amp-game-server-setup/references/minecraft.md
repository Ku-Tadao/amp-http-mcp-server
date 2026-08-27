# Minecraft on AMP

Minecraft has a purpose-built module, so its nodes do **not** use the `Meta.` prefix that
GenericModule games use. Config nodes are `MinecraftModule.<group>.<field>`, and the permission node
is that prefixed with `Settings.` — so `Settings.MinecraftModule.Game` covers the whole gameplay
group. Grant `Settings.MinecraftModule.Minecraft`, `.Game` and `.Limits` to configure a server, plus
`.Java` for memory tuning.

## Server type — ask this first

It determines which version fields matter and whether mods are possible at all.

| Type | `ServerType` | Mods/plugins |
| --- | --- | --- |
| Vanilla | `Vanilla` | none |
| Paper | `Paper` | Bukkit/Spigot plugins, good performance, most friends servers want this |
| Spigot / CraftBukkit | `Spigot` | plugins |
| Forge | `Forge` | Forge mods, needed for most big modpacks |
| NeoForge | `NeoForge` | NeoForge mods, the modern Forge fork |
| Fabric | `Fabric` | Fabric mods, lighter, popular for performance packs |
| Purpur / Folia / Velocity / Sponge | matching value | specialised |

If they want a **modpack** rather than individual mods, ask for the pack name — AMP can install FTB
packs directly via `MinecraftModule.Minecraft.FTBModpackNew`. CurseForge packs are usually easier
installed by pointing the instance at the pack's server files.

Version fields are per-type: `SpecificVersion` for vanilla, `SpecificPaperVersion`,
`SpecificForgeVersion`, `FabricMCVersion` plus `FabricLoaderVersion`, and so on. Setting the wrong
one silently does nothing, so set the field matching the chosen `ServerType`.

## Settings worth asking about

**Gameplay** (`MinecraftModule.Game.*`)

| Node | Setting | Notes |
| --- | --- | --- |
| `Difficulty` | peaceful / easy / normal / hard | |
| `GameMode` | survival / creative / adventure / spectator | |
| `ForceGameMode` | Force gamemode on join | |
| `HardcoreMode` | Hardcore | Death is permanent — confirm they mean it |
| `EnablePVPCombat` | PvP | Usually the single most consequential answer for a friends server |
| `Whitelist` | Use whitelist | The practical alternative to a password; Minecraft has no server password |
| `AllowFlight` | Allow flight | Turn on if they run flight mods, or anti-cheat kicks players |
| `AllowCommandBlocks` | Command blocks | |
| `SpawnProtectionRadius` | Spawn protection | Set `0` if they want to build at spawn |
| `EnableMonsters` / `EnableAnimals` / `EnableNPCs` | Mob spawning | |

**World and network** (`MinecraftModule.Minecraft.*`)

| Node | Setting | Notes |
| --- | --- | --- |
| `ServerMOTD` | MOTD | Shown in the server list; supports colour codes |
| `LevelName` | World folder | Changing it loads or creates a **different world** |
| `WorldSeed` | Seed | Only affects a world that doesn't exist yet |
| `WorldType` | Default / flat / large biomes / amplified | |
| `ViewDistance` | View distance | 10 is a good default; drop to 6–8 on a busy host |
| `SimulationDistance` | Simulation distance | Costs more CPU than view distance |
| `PreventProxy` | Disallow proxied connections | Leave **off** for Velocity/BungeeCord setups |

**Limits** (`MinecraftModule.Limits.*`): `MaxPlayers`, plus `SleepMode` and `SleepDelayMinutes` to
idle the server when empty — worth suggesting on a host running several servers.

**Java** (`MinecraftModule.Java.*`): `MaxHeapSizeMB` matters for modpacks. Vanilla or Paper is fine
around 2–4 GB; a large modded pack wants 6–8 GB. Check the host actually has it before promising —
`ADSModule/GetInstances` reports free RAM under the target's `Fitness`.

## EULA

Minecraft servers won't start until Mojang's EULA is accepted. AMP exposes
`MinecraftModule.Minecraft.SkipEULACheck`, but accepting a licence agreement is the user's decision,
not yours. If the server won't start for this reason, tell them it needs accepting and let them do
it in the panel.

## Ports

Game port and SFTP port, via `MinecraftModule.Minecraft.PortNumber` and
`FileManagerPlugin.SFTP.SFTPPortNumber` in `SetInstanceNetworkInfo`. Default game port is 25565;
subsequent servers on one host typically go 25566, 25567 and so on. Java Edition is TCP.
