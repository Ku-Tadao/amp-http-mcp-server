# GenericModule games (Necesse, Valheim, Palworld, Terraria, most SteamCMD titles)

AMP runs these from a downloaded template rather than a purpose-built module, so their settings all
share one shape. The exact node list differs per game — everything below is the pattern plus a
worked example, not a universal list.

## How the nodes are named

Config nodes look like `Meta.GenericModule.<fieldName>`, where `<fieldName>` comes from the game's
config manifest. The matching permission node is the config node prefixed with `Settings.`, so
`Meta.GenericModule.world` needs `Settings.Meta.GenericModule.world`, and granting the parent
`Settings.Meta.GenericModule` covers every game setting at once.

Two fields use AMP's own placeholders rather than the game's names: `$GamePort` and `$MaxUsers`.

## Finding the real list for a given game

The template that defines them is public, and reading it is faster than guessing:

```bash
curl -sL https://raw.githubusercontent.com/CubeCoders/AMPTemplates/main/<game>config.json
```

Each entry's `FieldName` is the part after `Meta.GenericModule.`. Or, on an instance where the app
is already installed, `Core/GetSettingsSpec` returns every node with its current value — that also
confirms the app finished installing, since these nodes don't exist before then.

## Necesse (verified)

| Node | Setting | Default | Notes |
| --- | --- | --- | --- |
| `Meta.GenericModule.world` | World name | `world` | Changing this **loads or creates a different world**. Never change it on a server people have played on |
| `Meta.GenericModule.motd` | MOTD | `Welcome to Necesse` | `\n` for newlines |
| `Meta.GenericModule.password` | Server password | empty | Empty means anyone who finds the port can join |
| `Meta.GenericModule.owner` | Owner name | empty | The connecting player with this exact name gets owner rights |
| `Meta.GenericModule.$MaxUsers` | Player limit | 10 | |
| `Meta.GenericModule.pauseWhenEmpty` | Pause when empty | `false` | Worth turning on — stops ticking a world nobody is in |
| `Meta.GenericModule.giveClientsPower` | Give clients power | `true` | Better feel, weaker anti-cheat |
| `Meta.GenericModule.worldBorderSize` | World border | `-1` | `-1` is unlimited |
| `Meta.GenericModule.droppedItemsLifeMinutes` | Dropped item lifetime | `0` | `0` is forever |
| `Meta.GenericModule.unloadSettlements` | Unload settlements | `false` | Turning on saves CPU, settlers stop working while unloaded |
| `Meta.GenericModule.maxSettlementsPerPlayer` | Settlement cap | `-1` | |
| `Meta.GenericModule.language` | Log language | `en` | ISO 639-1, only affects logs |

Necesse has no difficulty or PvP setting — don't offer them. If someone asks for "hard mode", that's
a world-creation choice inside the game, not a server setting.

## Suggested defaults for a friends server

- `pauseWhenEmpty` → `true`, especially on a host running several servers
- `$MaxUsers` → leave at the template default unless they name a number
- `password` → **leave empty and say so**, rather than inventing one
- `owner` → **leave unset and ask for their in-game name**, since it's an exact string match

## Mods

Steam Workshop items are set with `Settings.steamcmdplugin.SteamWorkshop.WorkshopItemIDs`, then
`Core/UpdateApplication` downloads them into the instance's `workshop` directory. Several templates
(Necesse included) then need each mod's jar copied into a `mods` directory before the server loads
it — check the template's `Mods` setting description, which spells out the per-game step.

## Ports

Most of these games need one UDP or TCP game port plus AMP's SFTP port. Some want a separate query
port. `ADSModule/GetInstanceNetworkInfo` lists exactly which ports the instance has and their
`ProvisionNodeName` keys — read it rather than assuming there is only one.
