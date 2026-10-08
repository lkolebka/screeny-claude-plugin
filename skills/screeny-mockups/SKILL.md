---
name: screeny-mockups
description: Make device mockups and 3D animations with Screeny. Use when the user wants a screenshot or screen recording framed in an iPhone, iPad or Mac, App Store or marketing screenshots, a 3D product shot, a 3D animation or product video of their app, a transparent device render to composite, or anything to do with their Screeny projects or what is open in the Screeny editor.
---

Screeny is a Mac app. Its tools reach it through the `screeny` connector, and they work only while the app is open with **Settings → Automation → MCP Server** turned on.

## If the tools are missing or failing

If only `screeny_status` is listed, or a Screeny tool answers that Screeny isn't reachable, call `screeny_status`. It reconnects when it can and returns Screeny's own usage notes. When it can't, ask the user to open Screeny and turn that toggle on, then carry on. Don't work around it with another tool.

## The order of work

1. **Find the valid values.** Call `list_devices` before naming a device, a bezel color, a lighting setup or a camera movement. Colors are specific to each device, and fewer devices and colors exist in 3D than flat. Nothing is substituted: an invalid value is refused with what is available.
2. **Start from what the user already has** when they mention it: `list_presets`, `list_projects`, `get_project`, `get_editor_configuration`. A look read from one of these can be passed straight back, because the read tools and the write tools use the same names.
3. **Look before exporting.** `preview_mockup` returns a small picture and costs nothing. For a video, pass `frames` or `times` to get the whole animation on one contact sheet in a single call. Check that the device isn't cropped, that a dark device still reads against its background, and that each close-up shows what it was meant to. Fix and preview again.
4. **Export** with `create_mockup` (PNG) or `create_video_mockup` (MP4, or MOV with alpha on a transparent background). Tell the user where each file was saved.

## Files

Screeny is sandboxed. It reads and writes only inside folders the user has granted.

- When a source file or an `output_path` fails with a folder-permission error, call `request_folder_access` for that folder, then retry the same call. The user approves in a macOS panel; you can't grant it yourself.
- Use absolute paths.
- Screeny never overwrites a file. Pass a folder as `output_path` to let it name the file, and save next to the source or where the user asked.
- You can't see the user's screenshot unless they show it to you. To aim a push-in at something on the screen, ask where it is, or preview and adjust.

## Credits

Exports cost Screeny credits unless the user is on an unlimited plan: 1 per image, 3 per video. Previews, projects and editor changes are free. Call `get_credits` before a large batch, and say so when the balance won't cover it. Nothing here can buy credits.

## Making it look good

When the user leaves the look to you:

- A dark background, a long lens and the Bars or Showroom lighting are most of what makes a 3D render read as a product shot. Light pastel backgrounds under the default lights look flat.
- On a very dark background, check the preview: a dark phone can lose its outline. Lift the background slightly rather than exporting a silhouette.
- For a matching set of stills, keep `camera.fill` the same across them so the device is the same size.
- For compositing, use a transparent background.

## Animation

- **No directing needed:** chain Screeny's own camera movements in `movements`, two or three back to back. `list_devices` gives their ids, names and lengths.
- **A described shot:** give a movement its own `poses` instead of a preset. Think like a camera operator: where it starts, what happens, where it ends, how long. Movements placed back to back with different poses read as hard cuts.
- Poses move the camera round a device that stays upright. A phone that lies down and stands up is what the built-in movements do; say so instead of faking it with a steep pitch.
- A light sweep shows on the body of the device, not on a lit screen. Use the back or a three-quarter view.
- A flat (non-3D) video animates with `keyframes`, push-ins on the device. Their zoom multiplies the framing: 100 is no extra zoom, 200 is twice as close.
- A recording can have an intro before it plays (`lead_in`) and be cut (`trim`).

**iPhone Duo.** The folding phone takes two pictures, one for the cover and one for the inner display (`other_screen`), and has its own animations. Its default `fill` is smaller than other devices', so read its framing before writing poses after one of its animations, or the phone jumps in size between them.

## Projects and the editor

- A project is a saved mockup: its items, its look and its animation. `create_project` with no items saves a look to reuse; `like_project` and `like_editor` start a render or a new project from an existing look.
- `update_editor` changes what the user has open while they watch. Use it when they say "what I have open"; use `open_in_editor` to show them a result.
- With `like_editor` or `like_project` and no source, the render tools export that mockup as it is.
- `delete_project` is permanent. Confirm the exact project and folder with the user first.

## While Screeny renders

Screeny renders one thing at a time, and a video export needs the app in the foreground. A call made during another render is told to try again: wait and retry rather than starting something else.
