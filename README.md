# 48X Claude Code plugins

This is the 48X plugin marketplace for Claude Code. For now it holds one plugin, `x48-usage`, the mod the 48X AI Usage app reads your limits from.

## x48-usage

Claude Code knows your official 5-hour and weekly limits, but it only shows them inside a session. This mod passes them to the 48X AI Usage app, so the app can show them in its toolbar and warn you before you run out. It works in Claude Code in the terminal, in the Code tab of the Claude desktop app and in VS Code.

What it does, exactly:

- **Reads:** Claude Code's usage figures for the session. That's your 5-hour and weekly percentages and their reset times, how full the context window is, and the session's cost. It never sees your prompts, Claude's replies or your tool calls.
- **Writes:** one small JSON file per session, into the 48X AI Usage app's own folder (`~/Library/Application Support/com.48x.aiusage` on macOS, `%LOCALAPPDATA%\com.48x.aiusage` on Windows, `~/.local/share/com.48x.aiusage` on Linux). The session id is only stored hashed, as part of the file name.
- **Doesn't:** make network requests, run programs, call a model, or change your settings. It never creates folders either. If the app hasn't set up its folder, the mod writes nothing.

You can check this yourself. `claude plugin validate --strict` lists every event a plugin hooks and every call it makes.

### Requirements

- Claude Code 2.1.287 or later in the terminal, or the Claude desktop app with Claude Code 2.1.286 or later (`/status` in the Code tab shows the version).
- The 48X AI Usage app, installed and opened once, so its folder exists.

### Install

The 48X AI Usage app can do this for you from Settings › Connections. To do it by hand, pick one:

- **In the Claude app:** open Customize › Plugins, choose Add › Add marketplace, enter `48X-Dev/claude-plugins`, then add `x48-usage`. It's saved to your Claude account and updates on its own.
- **In a Claude Code session:** run `/plugin marketplace add 48X-Dev/claude-plugins`, then `/plugin install x48-usage@48x`.
- **In a terminal:** run `claude plugin marketplace add 48X-Dev/claude-plugins`, then `claude plugin install x48-usage@48x`.

Sessions that are already open pick it up the next time they start, or straight away after `/reload-plugins`.

### Remove

Open `/plugin`, find `x48-usage` on the Installed tab and uninstall it, or use Remove in the app's Settings › Connections. Delete the app's folder too if you want the saved files gone.

### For IT teams

To install the mod for everyone, use Claude Code's managed settings (the claude.ai admin console, MDM or `managed-settings.json`). Set `extraKnownMarketplaces` to this repository and `enabledPlugins` to `{ "x48-usage@48x": true }`. If your organisation sets `allowManagedModsOnly`, a plugin installed from a GitHub marketplace won't load. In that case, use the directory install the app's IT snippet describes, which counts as your organisation's own.

## Where the code lives

The source of truth is the 48X AI Usage app's repository. This repository is published from it, so changes made here directly would be overwritten. To report a security problem, use GitHub's private vulnerability reporting on this repository rather than opening a public issue.
