# Screeny for Claude

Device mockups and 3D animation, from a conversation with Claude. This plugin connects Claude to [Screeny](https://getscreeny.app), a Mac app that turns iPhone, iPad and Mac screenshots and screen recordings into finished mockups: a flat bezel or a 3D model of the device, a clean status bar, a styled background and camera animation, saved as PNG or video.

Ask for things like:

- "Frame the screenshots in ~/Desktop/v2 in an iPhone 17 Pro on a dark gradient, for the App Store."
- "Make a 3D product shot of home.png on a Silver iPhone, turned 30 degrees, long lens, transparent background."
- "Turn demo.mov into a 9:16 video mockup with a camera move as an intro."
- "Export what I have open in Screeny to my Desktop."

## What you need

- A Mac with **Screeny** installed and open. Get it at [getscreeny.app](https://getscreeny.app).
- In Screeny, **Settings → Automation → MCP Server** turned on.
- [Node.js](https://nodejs.org) 18 or later on your `PATH`.

The plugin works in Claude Code and in Cowork sessions that run on your own computer. It can't work in chat on the web or on a phone, because it has to reach an app on your Mac.

## Install

In Claude Code:

```
/plugin install screeny --marketplace lkolebka/screeny-claude-plugin
```

In the Claude desktop app, go to **Customize > Plugins > Add > Add marketplace** and enter `lkolebka/screeny-claude-plugin`.

## What is in the plugin

- **A connector, `screeny`.** A small local program, `server/bridge.js`, that Claude starts and that passes Claude's requests to the Screeny app on your Mac. It gives Claude Screeny's own tools: listing devices and presets, previewing a mockup, exporting images and videos, working with your Screeny projects and with what is open in the editor, and asking you for access to a folder.
- **A skill, `screeny-mockups`.** How to use those tools well: look up valid devices first, preview before exporting, ask for folder access when a file can't be read, and what makes a render look like a product shot.

If Screeny isn't running when Claude starts, the connector says so and keeps looking for it. Open Screeny and its tools appear without restarting anything.

## What it runs, sends and stores

`server/bridge.js` is the only code the plugin runs. It is plain JavaScript with no dependencies, and you can read it in a few minutes.

- It talks to **one place only**: the Screeny app on your own machine, at `http://127.0.0.1` on a port from 9410 to 9419. It makes no other network request and reaches nothing on the internet.
- While Screeny is closed it tries those ports every five seconds to find it, by sending the MCP handshake. If some other app of yours is listening on one of them, that app receives the handshake too: once a minute at most, and nothing else.
- It reads no files, writes no files, starts no other program and reads no credentials. It keeps nothing between runs.
- It sends Screeny what Claude asks for: tool names and their arguments, which include the paths of the screenshots you want framed. Screeny reads those files itself.

What Screeny then does is up to the app, not this plugin: it renders on your Mac, reads and writes only inside folders you have granted it in a macOS panel, and never overwrites or deletes a file there. Exports use your Screeny credits (1 per image, 3 per video) unless you are on an unlimited plan; previews are free. See [Screeny's MCP guide](https://getscreeny.app/help/guide/mcp-server).

Set `SCREENY_MCP_URL` to the address shown in Screeny's settings if the app is somewhere the plugin doesn't look.

## Privacy Policy

The plugin collects nothing and sends nothing off your Mac. Your screenshots and recordings are rendered locally by Screeny and never uploaded. The Screeny app's own privacy policy, which covers its anonymous usage analytics, is at [getscreeny.app/privacy](https://getscreeny.app/privacy).

## Troubleshooting

- **Claude only lists `screeny_status`, or says Screeny isn't reachable.** Open Screeny and check Settings → Automation → MCP Server. The row there shows a green dot and the address when the server is running.
- **"File not found (or its folder isn't readable)".** Screeny hasn't been granted that folder. Claude will ask for it; click Grant Access in the panel that opens.
- **A video export fails part way.** Keep Screeny in the foreground until it finishes.
- **You already added Screeny to Claude Code by URL.** Remove one of the two, or its tools are listed twice.

## Development

The tests run the real bridge against a stand-in for the app:

```
node --test test/bridge.test.js
```

## Support

[getscreeny.app/help/contact](https://getscreeny.app/help/contact) or hello@getscreeny.app.

## License

MIT. Screeny itself is a separate, commercial app.
