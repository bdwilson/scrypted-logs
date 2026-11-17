# scrypted-logs

A small command-line tool for reading [Scrypted](https://www.scrypted.app/) plugin and camera consoles on the machine running Scrypted: the macOS desktop app, or Linux (native install or Docker). It can:

- **list** every plugin with its current console port, and its devices
- **tail** chosen plugins or cameras live, to your terminal and to log files, and follow them across restarts
- **grep** every console Scrypted holds in memory for a keyword or regex
- **dump** a console's in-memory buffer once
- **notifications**: a timeline of every detection, showing which phones and browsers got a push and, for the rest, why not

It needs no Scrypted login, no `npm install` and no extra dependencies. It's a single file, `scrypted-logs.mjs`, run with Node.

> It reads **internal, unauthenticated** Scrypted ports. These aren't a supported interface and may change in a future Scrypted release. Tested with Scrypted server **0.147.0** (desktop app, macOS, Apple Silicon). Linux support is newer; see [Linux](#linux).

## Why see what was suppressed?

Scrypted NVR records every detection, but it only tells you about the notifications it sends. When it skips one, it logs, at most, "Not sending detection. No new detections found, filtered, or snoozed." That doesn't say which reason applied or which device missed out. So when you *didn't* get an alert, you can't easily tell whether something is broken or working as intended.

That matters most when something else changes your notification settings for you. [Scrypted Connect for Hubitat](https://github.com/bdwilson/hubitat/tree/master/Scrypted) is one example. It lets Hubitat mute and unmute Scrypted camera notifications while recording continues. Its Motion Disabler app can mute chosen cameras for a while when a contact, lock, motion or presence event happens. Cameras can also be muted by Home/Away mode, a hub switch, or Rule Machine rules. The idea is that opening the door to walk the dog shouldn't send pushes about you to your own phone. With automations like that, you'll want to know:

- **Did the mute happen in time?** The settings history is timestamped to within about a second. The report shows whether the mute came before or after the detections it was meant to cover.
- **Did it unmute afterwards?** Later detections either show `sent` or tell you the camera is still muted.
- **Was a skip the automation, or something else?** Was the type turned off, snoozed, or blocked by an AI, Zones & Schedules filter (a squirrel against "dog, cat, deer")? Was it removed by an Object Detection exclude zone, such as the road? Or did NVR decide a parked car wasn't moving?
- **Who got what?** Each phone, Mac and browser has its own settings, so one event can be `sent` to one device and `skipped` on another, each with its reason.

The same answers help when tuning filters and zones. You can see the alerts you missed and exactly why, instead of guessing from the timeline.

---

## Install

1. **Scrypted** must be installed and running on this machine. See [Desktop App install](https://docs.scrypted.app/install/desktop-app.html), [Mac terminal install](https://docs.scrypted.app/install/mac-terminal.html) or [Installation](https://docs.scrypted.app/installation.html) for Linux.
2. **Node.js 18 or newer.** On a Mac with Homebrew:
   ```bash
   brew install node
   ```
   On Linux, use your distribution's package or [NodeSource](https://github.com/nodesource/distributions). You can also download it from [nodejs.org](https://nodejs.org/en/download).
3. **Get the script.** Clone it anywhere, for example `~/code/scrypted-logs`:
   ```bash
   git clone https://github.com/bdwilson/scrypted-logs.git ~/code/scrypted-logs
   ```
   Nothing else is needed on a Mac. The script uses Node built-ins, `lsof`, and the database library bundled inside `Scrypted.app`. On Linux, see [Linux](#linux).
4. **Optional:** add a shell alias so you can run it from anywhere:
   ```bash
   echo 'alias scrypted-logs="node ~/code/scrypted-logs/scrypted-logs.mjs"' >> ~/.zshrc && source ~/.zshrc
   ```

Check that it works:
```bash
node scrypted-logs.mjs list
```

---

## Usage

### `list`: plugins, ports and devices

```bash
node scrypted-logs.mjs list
```
```
@scrypted/hikvision  (hikvision)  port 54133
    Garage Front                     id 72   Camera       nativeId f9ce5ccd
    Front Porch                      id 73   Camera       nativeId 3da76500
@scrypted/reolink  (reolink)  port 40140
    Doorbell                         id 50   Doorbell     nativeId 6469cb43
...
```
Ports change every time a plugin or Scrypted restarts, so the other commands always look them up by name.

### `tail`: follow live and save to files

```bash
node scrypted-logs.mjs tail hikvision                 # a plugin's own console
node scrypted-logs.mjs tail "Front Porch" Doorbell    # one or more cameras
node scrypted-logs.mjs tail --all                     # every plugin and device
```

| Option | Effect |
|---|---|
| `--quiet` | Write files only. This is automatic when output isn't a terminal, e.g. under `nohup` or launchd. |
| `--stdout` | Always print to the terminal, even when redirected. |
| `--dir <path>` | Write logs somewhere other than the default: `~/Library/Logs/Scrypted/consoles/` on a Mac, `~/.local/state/scrypted-logs/consoles/` on Linux. |

- Each target gets its own file, in one folder per plugin, with lowercase hyphenated names (no spaces). On Linux the folder is `~/.local/state/scrypted-logs/consoles/`:
  ```
  ~/Library/Logs/Scrypted/consoles/
    hikvision/plugin.log          # the plugin's own console
    hikvision/front-porch.log     # a camera's console
    hikvision/garage-front.log
    nvr/plugin.log
    nvr/scrypted-nvr-object-detection.log
    core/phase-script.ts.log
    ...
  ```
  The folder is the plugin's short name (`prebuffer-mixin` is Rebroadcast, `objectdetector` is Video Analysis). If two devices in one plugin would get the same name, the Scrypted device ID is added (`doorbell-50.log`). Folders are `0700` and files `0600`.
- Search saved history with ordinary tools, e.g. `grep -ri timeout ~/Library/Logs/Scrypted/consoles/hikvision` or `tail -f ~/Library/Logs/Scrypted/consoles/hikvision/front-porch.log`.
- Every line gets an ISO timestamp. Scrypted's buffers only have a time marker every 5 minutes.
- On connect, Scrypted first **replays** its in-memory buffer, then streams live. The replay is bracketed by `#### replay begin` / `#### replay end` markers, because its timestamps are when the lines were received, not when they were logged.
- If a plugin or Scrypted restarts, the tool writes a `#### disconnected` marker, finds the new port and reconnects. The replay after a reconnect can repeat recent lines.

### `grep`: search everything in memory

```bash
node scrypted-logs.mjs grep -i "timeout|error"                 # all plugins and devices
node scrypted-logs.mjs grep -i "rtsp" hikvision "Front Porch"  # only some
node scrypted-logs.mjs grep -C 3 "registered \{" cloud         # 3 lines of context
```
- The pattern is a JavaScript regular expression. Use `-i` to ignore case and `-C n` to show context lines.
- With no targets, it searches every plugin console and every device console.
- Each match is labeled `~<time>`, the most recent 5-minute marker before it, so treat times as approximate.
- It only sees what Scrypted still holds in memory, roughly the last 2,000–4,000 writes per console, and it's cleared on restart. Use `tail` to keep history, then search the files with ordinary `grep`.

### `dump`: print a buffer once

```bash
node scrypted-logs.mjs dump "Garage Front"
node scrypted-logs.mjs dump --all > all-consoles.txt
```

### `notifications`: what was pushed, to whom, and why not

> **Requires `tail nvr objectdetector` to be running beforehand.** The report is built from what that tail saves:
> - the NVR plugin's console (`nvr/plugin.log`);
> - a history of notification settings (`nvr/notifier-settings.jsonl`);
> - the Object Detection plugin's console (`objectdetector/plugin.log`), which shows what its zones filtered out.
>
> `objectdetector` is optional. Without it, everything works except skips caused by Object Detection zones. The report can only cover periods when the tail was running. Start it once and leave it in the background (see [Run it in the background](#run-it-in-the-background)):
> ```bash
> node scrypted-logs.mjs tail nvr objectdetector --quiet
> ```
> Then run `notifications` whenever you like, in another terminal. If you use `--dir` for the tail, pass the same `--dir` to `notifications`.

For each detection, this lists every Scrypted NVR notifier device (each phone, Mac or browser that signed up for notifications) and whether it got a push. If it didn't, it says why, using Scrypted's own notification settings:
```
11/15, 3:53:57 PM  notification settings changed
    changed  Garage Front, Garage Back  custom notifications: none (was default notifications) on Scrypted macOS App (admin), Scrypted NVR Edge Browser (admin), Scrypted iPhone App (admin)
11/15, 3:54:01 PM  Garage Front — 1 person, face: Brian
    skipped  Scrypted macOS App (admin)         People, Familiar People are off (custom notifications for this camera: none)
    skipped  Scrypted iPhone App (admin)        People, Familiar People are off (custom notifications for this camera: none)
11/15, 3:58:27 PM  Garage Front — 3 people, faces: Brian, Michael
    sent     Scrypted macOS App (admin)         "Maybe: Brian"
    skipped  Scrypted iPhone App (admin)        Familiar People is off (default notifications: People, Package, Doorbell, Online/Offline, Vehicle, Animal); a face was recognized, so NVR held back People for Familiar People, which is off here
11/15, 4:08:11 PM  Garage Front — 1 vehicle
    skipped  Scrypted macOS App (admin)         Vehicle is off (default notifications: Familiar People, People, Package, Doorbell, Online/Offline)
    skipped  Scrypted iPhone App (admin)        Vehicle is on, but NVR didn't send (it doesn't log why: usually a stationary object, or the setting was different at the time)
```
```bash
node scrypted-logs.mjs notifications                                  # last 24 hours
```
```bash
node scrypted-logs.mjs notifications --since 15:50 --until 16:30      # a window today (24h or 3:50pm)
```
```bash
node scrypted-logs.mjs notifications "garage front" --since "2026-11-15 15:00"
```

**How the settings history is recorded.** It's part of the `tail` process. Nothing is installed in or added to Scrypted, and it's designed not to wear your disk. Whenever `nvr` is one of the tail's targets (including `tail --all`), the same process also:
1. **takes one snapshot at startup** as the baseline. It's a temporary, read-only copy of Scrypted's database (`~/.scrypted/volume/scrypted.db`): the table files are hard-linked and the journal is cloned with APFS copy-on-write, so almost nothing is written. The live database is never opened.
2. **then only reads.** Every database write lands first in LevelDB's journal file (`000NNN.log`), which Scrypted only ever appends to. Once a second the tail checks the journal's size, a metadata-only `stat` that writes nothing. When it has grown, the tail reads just the newly appended bytes and picks out writes to NVR's notifier devices and per-user **NVR Preferences** devices. It then updates its copy of each device's Default Notifications, its Custom Notifications per camera, and the **AI, Zones & Schedules** filters. Polling is used because macOS file-change notifications proved unreliable for this file. No snapshots and no disk writes, even when Scrypted is writing hundreds of times a minute; in testing it used about 0.1% CPU or less.
3. **appends a line** to `nvr/notifier-settings.jsonl` only when one of those settings changes. `t` is when the write was seen, and `after` is the previous read, so the change happened between the two: within about a second.

If a detection falls inside a change's window and the new settings explain why it was skipped, the report uses them and says so. This mainly matters for history recorded by earlier versions, which in practice only caught changes every 30 seconds; those are shown as "sometime between … and …". History from before filters were recorded is explained using today's filters, and the report says so.

That captures changes from the Scrypted UI, from automations or scripts that edit those settings, and from anything else. A notification's Snooze button isn't a setting; it shows up in the NVR log as a `snoozing …` line instead. If the tail stops, recording stops. Without that history, the report explains skips using the **current** settings and says so, which may not match what was set at the time. With no saved NVR log at all, it falls back to the in-memory console, with approximate times. Periods when `tail` wasn't running are invisible.

**Statuses:**

| Status | Meaning |
|---|---|
| `sent` | That device got a push for this event. The push text is shown. If some detected types were off for it, those are noted too. |
| `skipped` | No push to that device, with the reason (below). |
| `changed` | A notification setting changed, showing which cameras and devices. |

**Skip reasons, following NVR's own rules** (Scrypted NVR 0.13, per notifier device):
- **The type is off.** Each detection maps to a type: *People* (person), *Familiar People* (a recognized face), *Animal*, *Vehicle* or *Package*. A device only gets types that are on for that camera, using the camera's **Custom Notifications** list if it has one, otherwise the device's **Default Notifications**. A camera with an empty custom list gets nothing.
- **A face was recognized.** NVR then holds back *People* and *Animal* for that camera for a minute and sends *Familiar People* instead. If Familiar People is off on a device, that device gets nothing for the event.
- **Snoozed.** After an alert, the same camera and type is snoozed for 1 minute. The 10, 30 or 60 minute snooze buttons on a notification do the same for longer.
- **Summary is on.** If the camera's list includes *Summary*, individual People/Animal/Vehicle alerts are replaced by summaries.
- **AI, Zones & Schedules filters.** Set per camera in the Scrypted app. They're stored on the server, in the user's *NVR Preferences* device, and apply to all of that user's devices unless a device has its own for that camera. NVR checks them before sending, so a detection only notifies if some filter matches all of the following:
  - it lists the detected type, for example Filter 1 for People/Vehicle and Filter 2 for Animal;
  - it's within the filter's schedule and days;
  - if the filter has an **AI description** (such as "dog, cat, deer"), the object matches it. NVR compares the object's CLIP image embedding with the text.
  - if the filter has a **drawn area**, the object is inside it.

  The report tells you when the type isn't in any filter or the time was outside the schedule. NVR doesn't log AI or area matches, so when only an AI description or area could have let it through, the report says it most likely didn't match. A squirrel against "dog, cat, deer, fox, raccoon" is an example.
- **Not moving.** NVR only notifies for objects it sees moving, unless they have a recognized face. It logs `[Camera] vehicle is stationary` (or person, or animal), and `Ignoring stationary vehicle`. For vehicles, it also logs `Ignoring vehicle motion due to clipped detection`: NVR couldn't measure the movement, because the vehicle crossed the edge of one of the image tiles it crops for detection, or because there was too much motion in the scene. Either way, NVR treats the vehicle as not moving. The report quotes whichever of these it finds near the event.
- **Object Detection zones.** These are set on the camera under *Object Detection → Zone: …* and stored in the Video Analysis Plugin. An *exclude* zone removes matching classes, for example vehicles on the road. An *include* zone keeps only what's inside it. This happens before NVR's notifier sees a detection, so nothing is pushed. Every 10 s while a camera is analyzing, the Object Detection console logs a `Detected (filtered)` summary listing what its zones removed. If that console is saved (`tail … objectdetector`), the report names the zone, such as `exclude zone "road"`. NVR's own `retain moving` line still appears for the object, because NVR's tracker runs before the zones are applied.
- **Unknown.** When a type is on and nothing above explains the skip, the report says it doesn't know.

**How it reads the logs:**
- **Detections** are NVR's `[Camera] retain moving <track> <class> <score>` and `[Camera] retain label face <name>` lines. Lines for the same camera less than 60 s apart form one event, and people are counted by distinct track ID.
- **Pushes** are NVR's `sending encrypted push {…}` lines. `title` is the camera, `subtitle` is the text, and `data.actionUrl` ends with the receiving device's Scrypted ID. Each alert normally goes out as text first, then a silent update with the snapshot (the iPhone app gets one push with the image); these are grouped. A push for the same camera from 5 s before the event to 30 s after it counts toward that event.
- **Snoozes** are NVR's `snoozing nvr-<camera>-<type>-… for N minutes` lines.
- **Not covered:** pushes from Advanced Notifier, HomeKit and other plugins. This only reports Scrypted NVR's own notifiers.

### Naming targets

| You type | Matches |
|---|---|
| `hikvision`, `nvr`, `@scrypted/nvr` | a plugin, by short name or full ID. Rebroadcast is `prebuffer-mixin`, Video Analysis is `objectdetector`. |
| `"Front Porch"` | a device by exact name (case-insensitive) |
| `porch` | every device whose name contains it |
| `73`, `3da76500` | a device by Scrypted ID or nativeId |

A **device console** includes output from the plugins attached to that camera (Rebroadcast, NVR, Video Analysis, WebRTC, Advanced Notifier and so on), each line prefixed with that plugin's name, the same as the camera's console in the Scrypted web UI. A **plugin console** holds the plugin's own messages. Video Analysis, for example, also logs a per-camera summary there.

---

## Run it in the background

Until the next logout or reboot:
```bash
nohup node ~/code/scrypted-logs/scrypted-logs.mjs tail --all > /dev/null 2>&1 &
```
To stop it:
```bash
pkill -f scrypted-logs.mjs
```

To start it at every login, save this as `~/Library/LaunchAgents/local.scrypted-logs.plist`. Replace `YOU` with your macOS user name and check the node path with `which node`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.scrypted-logs</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/code/scrypted-logs/scrypted-logs.mjs</string>
    <string>tail</string>
    <string>--all</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/Scrypted/scrypted-logs.err</string>
</dict>
</plist>
```
Load it:
```bash
launchctl load ~/Library/LaunchAgents/local.scrypted-logs.plist
```
Unload it:
```bash
launchctl unload ~/Library/LaunchAgents/local.scrypted-logs.plist
```

On Linux, a systemd user service does the same. Save this as `~/.config/systemd/user/scrypted-logs.service`, checking the node path with `which node`:

```ini
[Unit]
Description=scrypted-logs tail

[Service]
ExecStart=/usr/bin/node %h/code/scrypted-logs/scrypted-logs.mjs tail nvr objectdetector --quiet
Restart=always

[Install]
WantedBy=default.target
```
Enable it, and let it run without a login session:
```bash
systemctl --user enable --now scrypted-logs
```
```bash
sudo loginctl enable-linger $USER
```

Log files grow without limit, so rotate or delete old ones yourself.

---

## How it works

Scrypted's server runs each plugin in its own process and pipes the plugin's output into a **console server** in the main Scrypted process ([`plugin-console.ts`](https://github.com/koush/scrypted/blob/main/server/src/plugin/plugin-console.ts), wired up in [`plugin-host.ts`](https://github.com/koush/scrypted/blob/main/server/src/plugin/plugin-host.ts)). For each plugin it opens two random ports on `127.0.0.1`:

- a **reader** port. Send one line, a device's `nativeId` or `undefined` for the plugin itself, and it replays that console's buffer and then streams new output.
- a **writer** port, which other plugins use to write into a device's console.

The tool:

1. finds the main Scrypted process as the one listening on port **10443**, and lists its `127.0.0.1` ports. A Mac uses `lsof`; Linux reads `/proc`.
2. identifies each reader port. Every console buffer starts with a header line, `plugin version: <pluginId> <version>`. The tool connects with a made-up nativeId (`scrypted-logs-probe`), which makes Scrypted create an empty buffer holding just that header, and reads the plugin ID from it. Writer ports never reply.
3. gets device names and nativeIds by **copying** `~/.scrypted/volume/scrypted.db` (LevelDB) to a temp folder and reading the copy with the `classic-level` module Scrypted ships. The live database is never opened.
   - Table files are hard-linked, so they cost nothing.
   - On a Mac, the rest is cloned with APFS copy-on-write.
   - On Linux, the rest is copied: a reflink on btrfs or xfs, otherwise a plain copy. If hard links aren't possible, the table files are copied too. That happens when the database belongs to another user, such as root in Docker, or is on another filesystem. That's the whole database, about 35 MB here, once per `list`/`grep`/`notifications` run and once when `tail` starts.

Because ports are looked up by plugin ID each time, the tool survives port changes after restarts.

### Settings (environment variables)

| Variable | Default |
|---|---|
| `SCRYPTED_PORT` | `10443`, the HTTPS port used to find the server process |
| `SCRYPTED_VOLUME` | Found automatically. Linux checks the running server's own setting, then tries `~/.scrypted/volume` and `/server/volume`. |
| `SCRYPTED_APP_MODULES` | Found automatically: `Scrypted.app` on a Mac, the running server's install or `~/.scrypted/node_modules` on Linux, or `classic-level` installed next to the script |
| `XDG_STATE_HOME` | Linux: the default log folder is `$XDG_STATE_HOME/scrypted-logs/consoles` (`~/.local/state/...`) |

### Linux

Run it on the Scrypted machine itself. What it needs depends on how Scrypted is installed.

- **Native install, running as your user.** It should work as is. If it can't find the database module, set `SCRYPTED_APP_MODULES` to the `node_modules` folder that contains `classic-level`. To find it:
  ```bash
  find ~/.scrypted -maxdepth 6 -type d -name classic-level
  ```
- **Scrypted as root or another user, including Docker.** As a normal user, the tool can't see which process owns which port. It then probes every `127.0.0.1` listening port on the machine. Only Scrypted's console ports answer with a `plugin version:` header; anything else just gets one unanswered line and is ignored. It says when it does this. Running it as Scrypted's user (or with `sudo`) skips the probing.
- **Docker.** The database module lives inside the container, so install it next to the script once, with the npm that comes with Node:
  ```bash
  cd ~/code/scrypted-logs && npm install classic-level
  ```
  Also point it at the container's volume on the host if it isn't `~/.scrypted/volume`. The official compose file maps `~/.scrypted/volume` to `/server/volume`.
  ```bash
  export SCRYPTED_VOLUME=/path/to/scrypted/volume
  ```
  The database must be readable by your user; otherwise run with `sudo`. If the container doesn't use host networking (the official compose file does), its `127.0.0.1` ports aren't reachable from the host. Run the tool inside the container instead (`docker exec`).

---

## Caveats and security

- **Any local process or user can read these ports.** Scrypted doesn't require a login for them. This tool doesn't create that exposure, but be aware of it.
- **Logs can contain secrets**, such as camera RTSP URLs with usernames and passwords. The tool writes files `0600` in a `0700` folder. Be careful before sharing them.
- **Each probe leaves one empty console entry** named `scrypted-logs-probe` in each plugin's memory. It's a fixed name, so it doesn't grow.
- **Not a supported interface.** A Scrypted update could change the ports, the header line or the database layout.
- **Linux support is newer** than macOS support. Please report problems with your install type. In [cluster mode](https://docs.scrypted.app/maintenance/cluster.html), console ports may bind to the cluster address as well as `127.0.0.1`. This hasn't been tested.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `nothing listening on 10443` | Scrypted isn't running, or uses a different port (set `SCRYPTED_PORT`), or it runs in Docker without host networking (run inside the container). |
| A plugin shows `not running` in `list` | The plugin is disabled, crashed or still restarting. Scrypted waits about 60 s before restarting a crashed plugin. `tail` waits and connects when it comes back. |
| `(device list unavailable: …)` | The database copy or `classic-level` couldn't be loaded. Plugin consoles still work; check `SCRYPTED_VOLUME` / `SCRYPTED_APP_MODULES`; on Linux, see [Linux](#linux). |
| Nothing new appears after an action in the UI | That action may not log anything, or it logs to a different console (a plugin vs. a camera). Run `grep` across everything to find where it went. |

---

## Scrypted links

- Scrypted home: <https://www.scrypted.app/>
- Documentation: <https://docs.scrypted.app/>
  - [Installation](https://docs.scrypted.app/installation.html) · [Desktop app](https://docs.scrypted.app/install/desktop-app.html) · [Mac terminal](https://docs.scrypted.app/install/mac-terminal.html)
  - [Adding a camera](https://docs.scrypted.app/add-camera.html) · [Camera preparation](https://docs.scrypted.app/camera-preparation.html) · [Camera validation](https://docs.scrypted.app/camera-validation.html)
  - [Object detection](https://docs.scrypted.app/detection/object-detection.html) · [Motion detection](https://docs.scrypted.app/detection/motion-detection.html)
  - [HomeKit troubleshooting](https://docs.scrypted.app/homekit-troubleshooting.html) · [Remote access](https://docs.scrypted.app/maintenance/access.html) · [Cluster](https://docs.scrypted.app/maintenance/cluster.html)
- Source code: <https://github.com/koush/scrypted>. Console server: [`server/src/plugin/plugin-console.ts`](https://github.com/koush/scrypted/blob/main/server/src/plugin/plugin-console.ts). Cloud plugin: [`plugins/cloud`](https://github.com/koush/scrypted/tree/main/plugins/cloud)
- Community Discord: <https://discord.gg/DcFzmBHYGq>
