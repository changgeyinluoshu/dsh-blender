# dsh-blender-studio

> Let DeepSeek Harness (DSH) agents **model in Blender**: primitives, mesh edits, modifiers, booleans, materials, renders and exports — straight from the chat.

[中文说明](README.md) · [Changelog](CHANGELOG.md)

![A table built and rendered by the agent](docs/e2e-table.png)

## What you get

Ask DSH: *"build a table in Blender, four legs, wood colour, render it for me"* and the agent will use `blender_*` tools to create geometry, cut a hole with a boolean, bevel edges, assign a material, render a preview (which it can inspect with `read_image`) and export GLB/FBX/OBJ/STL/USD.

No cloud service, no npm dependencies, no Python packages: the DSH side is plain ESM JavaScript, the Blender side is a standard-library-only add-on.

## Install

```bash
git clone https://github.com/changgeyinluoshu/dsh-blender.git
cd dsh-blender-studio
./install.ps1          # Windows
./install.sh           # macOS / Linux
```

The installer is idempotent and reversible: it links the repository into `<Profile>/node_modules/dsh-blender-studio`, writes a managed block into `<Profile>/cordis.patch.yml` (with a backup), and copies the Blender add-on into Blender's user add-on folder (`-SkipAddon` / `SKIP_ADDON=1` to skip).

Alternative: `dsh plugin add github:changgeyinluoshu/dsh-blender` — the package ships its own bundle patch.

### Blender side

Enable **DSH Blender Bridge** in `Edit > Preferences > Add-ons` (Blender 4.2+: `Extensions`). It starts listening on `127.0.0.1:9880` and shows its status in the 3D viewport sidebar (N panel → DSH tab).

For a headless/CI Blender:

```bash
blender --background --python addon/dsh_blender_bridge/dsh_headless.py -- --port 9880
```

Or let the agent do it: `blender_configure action=install_addon`, then `blender_configure action=launch`.

## Verify

Ask DSH for `blender_status`, or `blender_configure action=doctor` when something is off.

## Tools

`blender_status`, `blender_list_objects`, `blender_create_primitive`, `blender_select_objects`, `blender_transform_object`, `blender_duplicate_objects`, `blender_object_ops`, `blender_delete_objects`, `blender_mesh_edit`, `blender_modifier`, `blender_boolean`, `blender_material`, `blender_render_view`, `blender_screenshot`, `blender_export`, `blender_import`, `blender_scene`, `blender_file`, `blender_run_python`, `blender_configure` — 20 tools in total; see the [Chinese README](README.md#工具清单) for the full table.

## Configuration

Works with zero configuration (host `127.0.0.1`, port `9880`). Override via `blender_configure action=set key=value`, `<DSH_HOME>/.dsh-blender-studio.json`, environment variables (`DSH_BLENDER_HOST`, `DSH_BLENDER_PORT`, `DSH_BLENDER_TOKEN`, `DSH_BLENDER_OUTPUT_DIR`, `DSH_BLENDER_EXECUTABLE`) or the plugin config in `cordis.patch.yml`.

## Architecture

```text
DSH plugin (20 blender_* tools)  ──TCP + NDJSON──▶  Blender add-on (29 commands)
lib/bridge.js                                        dsh_server.py
                                                     └─ bpy work stays on Blender's main thread
```

One request per connection, UTF-8 NDJSON, loopback only, optional shared token.

## Tests

```bash
npm run check          # syntax (JS + add-on Python compile)
npm test               # 11 offline unit tests
npm run verify:load    # load the plugin in a real cordis context, validate schemas
npm run test:addon     # pack -> unpack -> enable/disable in real Blender (19 checks)
npm run test:blender   # full modelling run on real Blender (20 checks)
```

Verified on Blender 5.2.2 LTS. Set `DSH_BLENDER_EXECUTABLE` if Blender is not in the usual places.

## Uninstall

```bash
./uninstall.ps1        # Windows (add -RemoveAddon to drop the Blender add-on too)
./uninstall.sh         # macOS / Linux (REMOVE_ADDON=1 for the same)
```

## Security

Loopback only by default; optional token; `blender_run_python` executes arbitrary bpy code by design — keep the bridge local.

## License

MIT — see [LICENSE](LICENSE).
