#!/usr/bin/env node
// scrypted-logs: find every Scrypted plugin's console port and tail the plugin
// or device consoles you pick to files. No login, no npm install.
//
//   node scrypted-logs.mjs list                    # plugins, their ports, their devices
//   node scrypted-logs.mjs tail hikvision          # a plugin's own console
//   node scrypted-logs.mjs tail "Front Porch" Doorbell
//   node scrypted-logs.mjs tail --all              # every plugin + every device
//   node scrypted-logs.mjs grep -i "timeout|error" hikvision   # search in-memory consoles
//   node scrypted-logs.mjs dump "Garage Front"     # print a console's buffer once
//   node scrypted-logs.mjs notifications --since 15:50   # which detections were pushed / skipped, and why
//       (needs `tail nvr` running: it saves nvr/plugin.log and records notifier settings changes)
//   See README.md for details.
//   options for tail: --quiet (files only; default when not a terminal), --stdout (force print), --dir <path>
//
// How it works (Scrypted server 0.147, see @scrypted/server dist/plugin/plugin-console.js):
// - The main server process hosts two 127.0.0.1 ports per plugin: a console
//   *reader* and a console *writer*. Ports are random and change on every
//   plugin/server restart.
// - A reader port takes one line (a device nativeId, or "undefined" for the
//   plugin's own console), replays its in-memory buffer, then streams live.
// - Every fresh console buffer begins with a header line
//   "plugin version: <pluginId> <version>". Sending a nativeId that doesn't
//   exist creates an empty buffer that holds just that header, which tells us
//   which plugin owns the port. Writer ports never reply.
// - Device names/nativeIds come from a *copy* of ~/.scrypted/volume/scrypted.db
//   (LevelDB) read with the classic-level module bundled in Scrypted.app.
//
// These are internal, unauthenticated ports: any local process can read them,
// and console output may contain camera RTSP URLs with passwords. Log files
// are created owner-only (0600).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const HTTPS_PORT = Number(process.env.SCRYPTED_PORT || 10443);
const VOLUME = process.env.SCRYPTED_VOLUME || path.join(os.homedir(), '.scrypted', 'volume');
const APP_MODULES = process.env.SCRYPTED_APP_MODULES || '/Applications/Scrypted.app/Contents/Resources/app/node_modules';
const PROBE = 'scrypted-logs-probe'; // fixed so repeated probes reuse one empty buffer per plugin
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- discovery ----------

function lsof(args) {
    try { return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return e.stdout || ''; }
}

function serverPid() {
    const pid = lsof(['-nP', `-iTCP:${HTTPS_PORT}`, '-sTCP:LISTEN', '-t']).split('\n').find(Boolean);
    if (!pid) throw new Error(`nothing listening on ${HTTPS_PORT}; is Scrypted running?`);
    return Number(pid);
}

function localPorts(pid) {
    return lsof(['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'])
        .split('\n').map(l => l.match(/^n127\.0\.0\.1:(\d+)$/)?.[1]).filter(Boolean).map(Number);
}

// Connect, send the probe id, return the pluginId from the header (or null for writer/other ports).
// The first-ever connection with a new id creates the empty buffer but replays nothing,
// so a miss is retried once; after that the probe buffer exists and answers at once.
async function probe(port) {
    return (await probeOnce(port)) ?? (await probeOnce(port));
}

function probeOnce(port, timeout = 600) {
    return new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1');
        let buf = '';
        const done = v => { clearTimeout(t); sock.destroy(); resolve(v); };
        const t = setTimeout(() => done(null), timeout);
        sock.on('connect', () => sock.write(PROBE + '\n'));
        sock.on('data', d => {
            buf += d.toString();
            const m = buf.match(/plugin version: (\S+)/);
            if (m) done(m[1]);
        });
        sock.on('error', () => done(null));
        sock.on('close', () => done(null));
    });
}

async function discoverPorts() {
    const ports = localPorts(serverPid());
    const results = await Promise.all(ports.map(async p => [p, await probe(p)]));
    const map = new Map(); // pluginId -> reader port
    for (const [port, pluginId] of results)
        if (pluginId) map.set(pluginId, port);
    return map;
}

// Snapshot the DB so we never touch the live, locked one. LevelDB's .ldb table files are
// immutable, so they're hard-linked (instant, no extra space). The rest, mainly the journal
// (up to ~4 MB), is cloned with APFS copy-on-write (`cp -c`), which writes no data, so frequent
// snapshots don't wear the disk; plain copy is the fallback on other filesystems.
let canClone = process.platform === 'darwin';
function snapshotDb(dest) {
    const src = path.join(VOLUME, 'scrypted.db');
    for (const f of fs.readdirSync(src)) {
        if (f === 'LOCK') continue;
        const s = path.join(src, f), d = path.join(dest, f);
        if (f.endsWith('.ldb')) { try { fs.linkSync(s, d); continue; } catch { } }
        if (canClone) {
            try { execFileSync('/bin/cp', ['-c', s, d], { stdio: 'ignore' }); continue; }
            catch { if (!fs.existsSync(s)) continue; canClone = false; } // gone mid-snapshot, or no clone support
        }
        try { fs.copyFileSync(s, d); } catch (e) { if (e.code !== 'ENOENT') throw e; } // compaction may remove files mid-copy
    }
}

// NVR notifier settings that decide which detections get pushed (see notificationsReport)
function notifierSettings(storage = {}) {
    const json = (v, dflt) => { try { return v == null ? dflt : JSON.parse(v); } catch { return dflt; } };
    const custom = {};
    for (const [k, v] of Object.entries(storage))
        if (k.startsWith('custom-notifications-')) custom[k.slice(21)] = json(v, []);
    return {
        defaultNotifications: json(storage.defaultNotifications, null),
        customCameras: json(storage.customCameras, []),
        custom,
        ownZones: compactZones(json(storage.cameraNotificationZonesJSON, {})),
    };
}

// "AI, Zones & Schedules" filters: {camId: {filterName: {...}}}. The drawn area's points are
// reduced to a flag; the rest is kept as NVR uses it.
function compactZones(zones) {
    const out = {};
    for (const [cam, filters] of Object.entries(zones || {})) {
        out[cam] = {};
        for (const [name, z] of Object.entries(filters || {})) {
            const c = {};
            for (const k of ['classes', 'ai', 'timeRange', 'days', 'timeZone', 'exclusion', 'critical']) if (z?.[k] != null && z[k] !== '') c[k] = z[k];
            if (z?.path?.length >= 3) c.area = true;
            out[cam][name] = c;
        }
    }
    return out;
}

// Object Detection ("Video Analysis Plugin") zones, kept in that plugin's storage as
// mixin:<camera>:<detector>:zoneInfos. Returns {camId: [{name, mode, classes, type}]}.
function detectionZones(storage = {}) {
    const out = {};
    for (const [k, v] of Object.entries(storage)) {
        const m = k.match(/^mixin:(\d+):\d+:zoneInfos$/);
        if (!m) continue;
        let infos;
        try { infos = JSON.parse(v); } catch { continue; }
        for (const [name, z] of Object.entries(infos || {})) {
            const mode = z?.filterMode || (z?.exclusion ? 'exclude' : 'include');
            (out[m[1]] ||= []).push({ name, mode, classes: z?.classes?.length ? z.classes : null, type: z?.type || 'Intersect' });
        }
    }
    return out;
}

// NVR device kinds that hold notification settings: notifiers ("push:<user>:...") and each
// user's shared preferences ("preferences:<user>"), whose filters apply to all of that user's
// notifiers unless a notifier has its own for that camera.
const nvrSettingsDevice = d => {
    if (d?.pluginId !== '@scrypted/nvr') return null;
    const m = String(d.nativeId).match(/^(push|preferences):([^:]+)/);
    return m ? { kind: m[1], user: m[2] } : null;
};

// raw = {notifiers: {id: {name, user, ...notifierSettings}}, prefs: {user: zones}} -> what the history stores
function buildSnapshot(raw) {
    const snap = {};
    for (const [id, n] of Object.entries(raw.notifiers)) {
        const { ownZones, user, ...rest } = n;
        const zones = { ...(raw.prefs[user] || {}), ...ownZones }; // NVR: the notifier's own filters for a camera win
        snap[id] = { ...rest, zones };
    }
    return snap;
}
function applyDevice(raw, id, d) {
    const k = nvrSettingsDevice(d);
    if (k?.kind === 'push') raw.notifiers[id] = { name: d.state?.name?.value ?? `device ${id}`, user: k.user, ...notifierSettings(d.storage) };
    else if (k?.kind === 'preferences') { raw.prefs[k.user] = compactZones(JSON.parse(d.storage?.cameraNotificationZonesJSON || '{}')); raw.prefIds[id] = k.user; }
}

async function readDevices() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrypted-logs-'));
    try {
        snapshotDb(tmp);
        const { ClassicLevel } = createRequire(import.meta.url)(path.join(APP_MODULES, 'classic-level'));
        const db = new ClassicLevel(tmp, { createIfMissing: false });
        await db.open();
        const devices = [];
        for await (const [k, v] of db.iterator({ gte: 'PluginDevice/', lt: 'PluginDevice0' })) {
            const d = JSON.parse(v);
            const dev = {
                id: k.split('/')[1],
                pluginId: d.pluginId,
                nativeId: d.nativeId ?? null,
                name: d.state?.name?.value ?? '',
                type: d.state?.type?.value ?? '',
            };
            if (nvrSettingsDevice(d)) { dev.nvrSettings = d; }
            if (d.pluginId === '@scrypted/objectdetector' && d.nativeId == null) dev.detectionZones = detectionZones(d.storage);
            devices.push(dev);
        }
        await db.close();
        return devices;
    }
    catch (e) {
        console.error(`(device list unavailable: ${e.message})`);
        return [];
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// ---------- selection ----------

const shortName = id => id.replace(/^@[^/]+\//, '').replace(/^scrypted-/, '');
// "Scrypted NVR Edge Browser (admin)" -> "scrypted-nvr-edge-browser-admin"
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'unnamed';

// Log file path relative to the output dir: <plugin>/plugin.log or <plugin>/<device>.log.
// The device id is appended only when two devices in one plugin would share a name.
function logFile(t, devices) {
    const dir = slug(shortName(t.pluginId));
    if (t.nativeId == null) return path.join(dir, 'plugin.log');
    const s = slug(t.name);
    const clash = s === 'plugin' || devices.some(d => d.pluginId === t.pluginId && d.id !== t.id && d.nativeId != null && slug(d.name) === s);
    return path.join(dir, `${clash ? `${s}-${t.id}` : s}.log`);
}

function resolveTargets(args, devices, ports) {
    const pluginIds = new Set([...ports.keys(), ...devices.map(d => d.pluginId)]);
    const targets = new Map(); // key -> {label, pluginId, nativeId, file}
    const add = t => targets.set(`${t.pluginId}|${t.nativeId ?? ''}`, { ...t, file: logFile(t, devices) });
    const addPlugin = p => add({ label: `plugin ${p}`, pluginId: p, nativeId: null });
    const addDevice = d => add({ label: `${d.name} [${d.id}]`, name: d.name, id: d.id, pluginId: d.pluginId, nativeId: d.nativeId });

    if (args.includes('--all')) {
        pluginIds.forEach(addPlugin);
        devices.filter(d => d.nativeId != null).forEach(addDevice);
        return [...targets.values()];
    }
    for (const q of args) {
        const ql = q.toLowerCase();
        const plugs = [...pluginIds].filter(p => p.toLowerCase() === ql || shortName(p).toLowerCase() === ql);
        if (plugs.length) { plugs.forEach(addPlugin); continue; }
        let devs = devices.filter(d => d.id === q || d.nativeId === q || d.name.toLowerCase() === ql);
        if (!devs.length) devs = devices.filter(d => d.name.toLowerCase().includes(ql));
        if (!devs.length) { console.error(`no plugin or device matches "${q}" (try: list)`); process.exit(1); }
        for (const d of devs) d.nativeId == null ? addPlugin(d.pluginId) : addDevice(d);
    }
    return [...targets.values()];
}

// ---------- tailing ----------

async function tail(t, outDir, toStdout, getPorts) {
    const file = path.join(outDir, t.file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    const mark = s => out.write(`#### ${new Date().toISOString()} ${s}\n`);
    let lastPort;
    while (true) {
        const port = (await getPorts()).get(t.pluginId);
        if (!port) { await sleep(5000); continue; } // plugin not running (yet)
        let partial = '', connected = false, replaying = false, replayTimer;
        await new Promise(resolve => {
            const sock = net.connect(port, '127.0.0.1');
            sock.on('connect', () => {
                connected = true;
                if (port !== lastPort) mark(`connected ${t.pluginId} ${t.nativeId ?? '(plugin)'} port ${port}`);
                lastPort = port;
                // Scrypted first replays its in-memory buffer in one burst; bracket it so
                // readers (and the notifications command) can tell history from live lines.
                mark('replay begin (buffered history: timestamps below are when received, not when logged)');
                replaying = true;
                replayTimer = setTimeout(() => { replaying = false; mark('replay end'); }, 1500);
                sock.write(String(t.nativeId ?? 'undefined') + '\n');
            });
            sock.on('data', d => {
                // console buffers have no per-line timestamps; add ours
                const lines = (partial + d.toString()).split('\n');
                partial = lines.pop();
                const ts = new Date().toISOString();
                out.write(lines.map(l => `${ts} ${l}\n`).join(''));
                if (toStdout) process.stdout.write(lines.map(l => `${ts} [${t.label}] ${l}\n`).join(''));
                if (replaying) { // replay ends after a short quiet gap
                    clearTimeout(replayTimer);
                    replayTimer = setTimeout(() => { replaying = false; mark('replay end'); }, 400);
                }
            });
            sock.on('error', () => {});
            sock.on('close', resolve);
        });
        clearTimeout(replayTimer);
        if (partial) out.write(`${new Date().toISOString()} ${partial}\n`);
        if (connected) mark('disconnected (plugin or server restart?) - will reconnect; replay may duplicate recent lines');
        await sleep(connected ? 1000 : 5000);
    }
}

// ---------- one-shot reads (grep / dump) ----------

// Read a console's in-memory buffer once: Scrypted replays it right after the
// selector line, then streams live; we stop once it's been quiet briefly.
function readBuffer(port, nativeId, { idle = 300, max = 5000 } = {}) {
    return new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1');
        const chunks = [];
        let idleTimer;
        const done = () => { clearTimeout(idleTimer); clearTimeout(maxTimer); sock.destroy(); resolve(Buffer.concat(chunks).toString()); };
        const maxTimer = setTimeout(done, max);
        sock.on('connect', () => { sock.write(String(nativeId ?? 'undefined') + '\n'); idleTimer = setTimeout(done, 1000); });
        sock.on('data', d => { chunks.push(d); clearTimeout(idleTimer); idleTimer = setTimeout(done, idle); });
        sock.on('error', done);
        sock.on('close', done);
    });
}

// Buffers only carry a "########" / local-time / "########" marker at most every
// 5 minutes, so each line is tagged with the most recent marker ("~time").
function* timedLines(text) {
    const lines = text.split('\n');
    let when = '';
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '########################' && lines[i + 2] === '########################') {
            when = lines[i + 1]; i += 2; continue;
        }
        yield { when, line: lines[i] };
    }
}

async function readTargets(args) {
    const [ports, devices] = await Promise.all([discoverPorts(), readDevices()]);
    // devices only: plugin consoles are included when named or with no filter
    const targets = resolveTargets(args.length ? args : ['--all'], devices, ports);
    return Promise.all(targets.map(async t => {
        const port = ports.get(t.pluginId);
        return { ...t, text: port ? await readBuffer(port, t.nativeId) : null };
    }));
}

// ---------- notifications report ----------
//
// For each detection, works out which NVR notifier devices (phones, Macs, browsers) got a push,
// and for the rest, why not. Uses only Scrypted's own data:
// - nvr/plugin.log (saved by `tail nvr`):
//     "[Camera] retain moving <track> <class> <score>" / "[Camera] retain label face <name>"
//         = detections NVR kept
//     "sending encrypted push {json}" = one push to one notifier: json.title = camera,
//         json.subtitle = text, json.data.actionUrl ends in the notifier's device id
//     "snoozing nvr-<cameraId>-<type>-<critical> for N minutes" = NVR's repeat guard
// - nvr/notifier-settings.jsonl (recorded by `tail nvr`): each notifier's notification
//   settings over time. Without it, the current settings are used.
// NVR's rules (Scrypted NVR 0.13.x, NotifierDevice.shouldDeliverCameraEvent), per notifier:
//   type = Familiar People (person/face with a recognized name), People, Animal, Vehicle, Package
//   the camera's type list = "Custom Notifications" for that camera if it has one,
//                            else the notifier's "Default Notifications"
//   skipped if: the type isn't in that list; "Summary" is in it (People/Animal/Vehicle);
//   the camera+type is snoozed (1 min after an alert, or 10/30/60 min from a notification's
//   snooze button; a recognized face also snoozes People and Animal); outside notification zones;
//   the object isn't moving.

const SETTINGS_FILE = 'nvr/notifier-settings.jsonl';
const NVR_DEFAULT_TYPES = ['Familiar People', 'People', 'Package', 'Doorbell', 'Online/Offline'];
const TYPE_OF_CLASS = cls =>
    /^(person|face)$/.test(cls) ? 'People'
        : /^(animal|bird|cat|dog|horse|sheep|cow|elephant|bear|zebra|giraffe|teddy bear)$/.test(cls) ? 'Animal'
            : /^(vehicle|car|truck|bus|motorcycle|bicycle|boat|airplane|train)$/.test(cls) ? 'Vehicle'
                : cls === 'package' ? 'Package' : null;

function loadFileLines(file) {
    if (!fs.existsSync(file)) return null;
    const out = [];
    let replay = false, connectAt = 0;
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = raw.match(/^(####\s+)?(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/);
        if (!m) continue;
        const t = Date.parse(m[2]), text = m[3];
        if (m[1]) { // marker line
            if (text.startsWith('replay begin')) replay = true;
            else if (text.startsWith('replay end')) replay = false;
            else if (text.startsWith('connected')) connectAt = t;
            continue;
        }
        // older files have no replay markers: the replay arrives right after "connected"
        const isReplay = replay || (connectAt && t - connectAt < 1000);
        if (!isReplay) out.push({ t, text });
    }
    return out;
}

async function loadMemoryLines(pluginId, nativeId, ports) {
    const port = ports.get(pluginId);
    if (!port) return [];
    const out = [];
    for (const { when, line } of timedLines(await readBuffer(port, nativeId)))
        if (when) out.push({ t: Date.parse(when), text: line, approx: true });
    return out;
}

function parseTime(s, fallback) {
    if (!s) return fallback;
    const hm = s.match(/^(\d{1,2}):(\d\d)\s*([ap]m)?$/i); // "15:50" or "3:50pm" = today
    if (hm) {
        let h = Number(hm[1]);
        if (hm[3]) h = h % 12 + (hm[3].toLowerCase() === 'pm' ? 12 : 0);
        const d = new Date();
        d.setHours(h, Number(hm[2]), 0, 0);
        return d.getTime();
    }
    const t = Date.parse(s);
    if (Number.isNaN(t)) { console.error(`can't parse time "${s}"`); process.exit(1); }
    return t;
}

const fmtTime = t => new Date(t).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

// --- settings history ---

function rawNotifierSettings(devices) {
    const raw = { notifiers: {}, prefs: {}, prefIds: {} };
    for (const d of devices.filter(d => d.nvrSettings)) { try { applyDevice(raw, d.id, d.nvrSettings); } catch { } }
    return raw;
}
const currentNotifierSnapshot = devices => buildSnapshot(rawNotifierSettings(devices));

// Runs alongside `tail nvr` and records NVR notifier settings changes without writing to disk
// (apart from the history line itself):
// - one database snapshot at startup gives the baseline settings;
// - after that, it only READS the bytes Scrypted appends to the database journal (LevelDB's
//   000NNN.log, where every write lands first) and picks out writes to notifier devices.
//   It checks the journal's size once a second (a metadata-only stat) and reads only new bytes.
// Each change is appended to nvr/notifier-settings.jsonl with:
//   t     = when the write was seen
//   after = the previous check (about 1 s earlier), so the change happened in (after, t]

// LevelDB journal reader: 32 KB blocks of [crc u32][len u16][type u8] fragments
// (1 FULL, 2 FIRST, 3 MIDDLE, 4 LAST) that form write batches:
// [sequence u64][count u32] then [tag u8: 1 put, 0 delete][varint keyLen][key][varint valLen][value]
class JournalReader {
    constructor(dir) { this.dir = dir; this.file = null; this.offset = 0; }
    current() { return fs.readdirSync(this.dir).filter(f => /^\d+\.log$/.test(f)).sort().at(-1) ?? null; }
    // start at the end of the current journal: everything before is in the baseline snapshot
    seekToEnd() { this.file = this.current(); this.offset = this.file ? fs.statSync(path.join(this.dir, this.file)).size : 0; }
    // returns [{key, value|null}] for complete batches appended since the last call
    readNew() {
        const out = [];
        const latest = this.current();
        if (this.file && latest !== this.file) { // journal rotated: finish the old one, then start the new one
            try { out.push(...this.#read(this.file)); } catch { }
            this.file = latest;
            this.offset = 0;
        }
        if (!this.file) { this.file = latest; this.offset = 0; }
        if (this.file) out.push(...this.#read(this.file));
        return out;
    }
    #read(name) {
        const p = path.join(this.dir, name);
        const size = fs.statSync(p).size;
        if (size <= this.offset) return [];
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(size - this.offset);
        try { fs.readSync(fd, buf, 0, buf.length, this.offset); } finally { fs.closeSync(fd); }
        const entries = [];
        let pos = 0, frags = [], batchStart = 0;
        while (true) {
            const abs = this.offset + pos;
            const left = 32768 - (abs % 32768);
            if (left < 7) { if (pos + left > buf.length) break; pos += left; continue; } // block trailer
            if (pos + 7 > buf.length) break;
            const len = buf.readUInt16LE(pos + 4), type = buf[pos + 6];
            if (type === 0 && len === 0) { if (pos + left > buf.length) break; pos += left; continue; } // padding
            if (pos + 7 + len > buf.length) break; // incomplete: wait for more
            if (type === 1 || type === 2) { frags = []; batchStart = pos; }
            frags.push(buf.subarray(pos + 7, pos + 7 + len));
            pos += 7 + len;
            if (type === 1 || type === 4) {
                entries.push(...JournalReader.#batch(Buffer.concat(frags)));
                frags = [];
                batchStart = pos;
            }
        }
        this.offset += batchStart; // resume at the first incomplete batch
        return entries;
    }
    static #batch(b) {
        const varint = o => { let r = 0, s = 0, x; do { x = b[o++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, o]; };
        const out = [];
        try {
            let o = 12;
            for (let n = b.readUInt32LE(8); n > 0; n--) {
                const tag = b[o++];
                let len;
                [len, o] = varint(o);
                const key = b.subarray(o, o + len).toString();
                o += len;
                let value = null;
                if (tag === 1) { [len, o] = varint(o); value = b.subarray(o, o + len).toString(); o += len; }
                out.push({ key, value });
            }
        }
        catch { } // a damaged batch is skipped; the next good one still counts
        return out;
    }
}

async function recordNotifierSettings(outDir, devices) {
    const file = path.join(outDir, SETTINGS_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const dbDir = path.join(VOLUME, 'scrypted.db');

    // baseline: the snapshot `tail` already took at startup
    const raw = rawNotifierSettings(devices);
    let snap = buildSnapshot(raw);
    const journal = new JournalReader(dbDir);
    journal.seekToEnd();
    const last = loadSettingsHistory(outDir).at(-1);
    let lastJson = last ? JSON.stringify(last.notifiers) : '';
    const record = (t, after) => {
        const json = JSON.stringify(snap);
        if (!Object.keys(snap).length || json === lastJson) return;
        fs.appendFileSync(file, JSON.stringify({ t: new Date(t).toISOString(), after: new Date(after).toISOString(), notifiers: snap }) + '\n', { mode: 0o600 });
        lastJson = json;
    };
    record(Date.now(), Date.now()); // settings may have changed while the tail wasn't running

    const applyJournal = entries => {
        for (const { key, value } of entries) {
            const id = key.match(/^PluginDevice\/(\d+)$/)?.[1];
            if (!id) continue;
            if (value === null) { delete raw.notifiers[id]; if (raw.prefIds[id]) delete raw.prefs[raw.prefIds[id]]; continue; }
            try { applyDevice(raw, id, JSON.parse(value)); } catch { }
        }
        snap = buildSnapshot(raw);
    };

    // Poll the journal's size once a second: a stat only reads file metadata (no disk writes, and
    // usually not even a disk read). macOS file-change notifications proved unreliable for this file.
    let lastRead = Date.now(), lastSize = -1, lastFile = null;
    while (true) {
        await sleep(1000);
        const now = Date.now();
        try {
            const cur = journal.current();
            const size = cur ? fs.statSync(path.join(dbDir, cur)).size : 0;
            if (cur !== lastFile || size !== lastSize) {
                lastFile = cur; lastSize = size;
                applyJournal(journal.readNew());
                record(now, lastRead);
            }
        }
        catch { }
        lastRead = now;
    }
}

function loadSettingsHistory(outDir) {
    const file = path.join(outDir, SETTINGS_FILE);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        // entries from before "after" was recorded came from a 30 s poll
        .map(l => { try { const j = JSON.parse(l); const t = Date.parse(j.t); return { t, after: j.after ? Date.parse(j.after) : t - 30000, notifiers: j.notifiers }; } catch { return null; } })
        .filter(Boolean).sort((a, b) => a.t - b.t);
}

// The types a notifier would send for a camera, and where that list comes from.
function typesFor(s, camId) {
    if (s.customCameras?.includes(camId)) return { types: s.custom?.[camId] ?? [], source: 'custom notifications for this camera' };
    return { types: s.defaultNotifications ?? NVR_DEFAULT_TYPES, source: 'default notifications' };
}

const listOrNone = a => a.length ? [...new Set(a)].join(', ') : 'none';
const fmtClock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// Minutes since midnight in a time zone (NVR compares schedule times this way).
function minutesOfDay(t, tz) {
    try {
        const p = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hour12: false, timeZone: tz || undefined }).formatToParts(new Date(t));
        return (Number(p.find(x => x.type === 'hour')?.value) % 24) * 60 + Number(p.find(x => x.type === 'minute')?.value);
    } catch { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); }
}
const fmtHM = (t, tz) => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Would NVR's "AI, Zones & Schedules" filters let this type through at time t? Mirrors NVR:
// a filter applies when it is in its schedule/days and lists the type; an AI description must
// also match the object (CLIP similarity, not logged); a drawn area must contain it (not logged).
// Returns null when the filters don't stop it, otherwise the reason.
function filterVerdict(filters, ty, t, detected) {
    const list = Object.entries(filters || {});
    if (!list.length || !['People', 'Familiar People', 'Animal', 'Vehicle'].includes(ty)) return null;
    if (!list.some(([, z]) => !z.exclusion)) return null; // only exclusion filters: NVR doesn't require a match
    const desc = ([n, z]) => `${n}: ${z.classes ? listOrNone(z.classes) : 'all types'}${z.ai ? `, AI "${z.ai.trim()}"` : ''}${z.area ? ', drawn area' : ''}`;
    const covers = list.filter(([, z]) => !z.exclusion && (!z.classes || z.classes.includes(ty)));
    if (!covers.length)
        return `${ty} isn't in any AI, Zones & Schedules filter for this camera (${list.filter(([, z]) => !z.exclusion).map(desc).join('; ')})`;
    const offSchedule = [];
    const active = covers.filter(([n, z]) => {
        if (z.timeRange?.length === 2) {
            const [a, b] = z.timeRange.map(x => minutesOfDay(x, z.timeZone)), now = minutesOfDay(t, z.timeZone);
            if (!(a <= b ? now >= a && now < b : now >= a || now < b)) { offSchedule.push(`${n} runs ${fmtHM(z.timeRange[0], z.timeZone)}–${fmtHM(z.timeRange[1], z.timeZone)}`); return false; }
        }
        if (z.days?.length) {
            const day = new Date(new Date(t).toLocaleString('en-US', { timeZone: z.timeZone || undefined })).getDay();
            if (!z.days.includes(day)) { offSchedule.push(`${n} runs ${z.days.map(d => DAY_NAMES[d]).join(', ')}`); return false; }
        }
        return true;
    });
    if (!active.length) return `outside the schedule of the AI, Zones & Schedules filters for ${ty} (${offSchedule.join('; ')})`;
    if (active.some(([, z]) => !z.ai && !z.area)) return null; // a plain filter lets it through
    const ai = active.filter(([, z]) => z.ai), area = active.filter(([, z]) => z.area && !z.ai);
    const bits = [];
    if (ai.length) bits.push(`only when it matches the AI description ${ai.map(([n, z]) => `"${z.ai.trim()}" (${n})`).join(' or ')}`);
    if (area.length) bits.push(`only inside the drawn area of ${area.map(([n]) => n).join(', ')}`);
    const what = detected?.length ? `this ${listOrNone(detected)}` : 'this detection';
    return `AI, Zones & Schedules: ${ty} notifies ${bits.join(', or ')}; NVR doesn't log the match, so ${what} most likely didn't match`;
}

// Why a notifier (settings s) would skip a detection of these types on this camera.
// unknown = true when the settings allow it and nothing in the logs explains the skip.
function explainNotifier(s, camId, types, snoozedTypes, faceSeen, t = Date.now(), detected = [], evidence = null) {
    const { types: enabled, source } = typesFor(s, camId);
    const off = [...types].filter(ty => !enabled.includes(ty));
    const offText = off.length ? `${off.join(', ')} ${off.length > 1 ? 'are' : 'is'} off (${source}: ${listOrNone(enabled)})` : '';
    let wanted = [...types].filter(ty => enabled.includes(ty));
    const bits = [];
    if (offText) bits.push(offText);
    // a recognized face makes NVR hold back People and Animal for a minute in favour of Familiar People
    const heldBack = faceSeen ? wanted.filter(ty => ty === 'People' || ty === 'Animal') : [];
    if (heldBack.length) {
        wanted = wanted.filter(ty => !heldBack.includes(ty));
        if (!enabled.includes('Familiar People'))
            bits.push(`a face was recognized, so NVR held back ${heldBack.join(' and ')} for Familiar People, which is off here`);
    }
    if (enabled.includes('Summary') && wanted.some(ty => ['People', 'Familiar People', 'Animal', 'Vehicle'].includes(ty))) {
        bits.push('Summary notifications are on for this camera, which replaces individual alerts');
        wanted = wanted.filter(ty => !['People', 'Familiar People', 'Animal', 'Vehicle'].includes(ty));
    }
    const snoozed = wanted.filter(ty => snoozedTypes.has(ty));
    if (snoozed.length) bits.push(`${snoozed.join(', ')} still snoozed from an alert just before`);
    const rest = wanted.filter(ty => !snoozed.includes(ty));
    let unknown = false;
    if (rest.length) {
        const filtered = [], open = [];
        for (const ty of rest) {
            const v = s.zones ? filterVerdict(s.zones[camId], ty, t, detected) : null;
            if (v) { filtered.push(ty); if (!bits.includes(v)) bits.push(v); } else open.push(ty);
        }
        if (filtered.length && s.zonesNow) bits[bits.length - 1] += ' (filters as they are now: older history didn\'t record them)';
        // what the logs show about the rest: removed by an Object Detection zone, or not moving
        const unexplained = [];
        for (const ty of open) {
            const found = evidence?.reasons(ty) ?? [];
            if (!found.length) unexplained.push(ty);
            for (const w of found) if (!bits.includes(w)) bits.push(w);
        }
        if (unexplained.length) {
            unknown = true;
            if (!s.zones && s.zoneCameras?.includes(camId)) // history from before filters were recorded
                bits.push(`${unexplained.join(', ')} on, but the camera has notification zones; it may have been outside them`);
            else
                bits.push(`${unexplained.join(', ')} ${unexplained.length > 1 ? 'are' : 'is'} on, but NVR didn't send (it doesn't log why: usually a stationary object, or the setting was different at the time)`);
        }
    }
    const why = bits.join('; ') || `nothing detected that this device is set to notify for (${source}: ${listOrNone(enabled)})`;
    return { why, offText, unknown };
}

// Human-readable changes between two settings snapshots.
function settingsChanges(prev, next, camName) {
    const out = [];
    for (const [id, n] of Object.entries(next)) {
        const p = prev[id];
        if (!p) continue;
        if (JSON.stringify(p.defaultNotifications) !== JSON.stringify(n.defaultNotifications))
            out.push({ notifier: n.name, camera: '', text: `default notifications: ${listOrNone(n.defaultNotifications ?? [])} (was ${listOrNone(p.defaultNotifications ?? [])})` });
        const cams = new Set([...(p.customCameras || []), ...(n.customCameras || [])]);
        for (const c of cams) {
            const a = typesFor(p, c), b = typesFor(n, c);
            if (JSON.stringify(a) === JSON.stringify(b)) continue;
            const desc = x => x.source.startsWith('custom') ? `custom notifications: ${listOrNone(x.types)}` : 'default notifications';
            out.push({ notifier: n.name, camera: camName(c), text: `${desc(b)} (was ${desc(a)})` });
        }
        if (p.zones && n.zones)
            for (const c of new Set([...Object.keys(p.zones), ...Object.keys(n.zones)])) {
                const a = p.zones[c] || {}, b = n.zones[c] || {};
                if (JSON.stringify(a) === JSON.stringify(b)) continue;
                const d = f => Object.entries(f).map(([k, z]) => `${k}${z.exclusion ? ' (exclude)' : ''}: ${z.classes ? listOrNone(z.classes) : 'all'}${z.ai ? ` AI "${z.ai.trim()}"` : ''}${z.area ? ' area' : ''}${z.timeRange || z.days?.length ? ' scheduled' : ''}`).join('; ') || 'none';
                out.push({ notifier: n.name, camera: camName(c), text: `AI, Zones & Schedules filters: ${d(b)} (was ${d(a)})` });
            }
    }
    return out;
}

async function notificationsReport({ outDir, since, until, cameraFilter }) {
    const [ports, devices] = await Promise.all([discoverPorts(), readDevices()]);
    const byId = new Map(devices.map(d => [d.id, d]));
    const camName = id => byId.get(id)?.name ?? `camera ${id}`;
    const camIdByName = name => devices.find(d => d.name === name && /Camera|Doorbell/.test(d.type))?.id
        ?? devices.find(d => d.name === name)?.id;

    // settings: recorded history, else the current settings
    const history = loadSettingsHistory(outDir);
    const current = currentNotifierSnapshot(devices);
    let usedCurrent = false;
    const settingsAt = t => {
        let s = null;
        for (const h of history) if (h.t <= t) s = h.notifiers; else break;
        if (!s) { usedCurrent = true; return current; }
        return Object.fromEntries(Object.entries(s).map(([id, n]) =>
            [id, n.zones || !current[id] ? n : { ...n, zones: current[id].zones, zonesNow: true }]));
    };

    // NVR lines: saved file (exact times) or, failing that, memory (approximate times)
    let nvr = loadFileLines(path.join(outDir, 'nvr', 'plugin.log'));
    let approxNvr = false;
    if (!nvr) { nvr = await loadMemoryLines('@scrypted/nvr', null, ports); approxNvr = true; }

    const inRange = l => l.t >= since && l.t <= until;
    const events = [], open = new Map(), pushes = [], snoozes = [], errors = [], still = [];
    for (const l of nvr.filter(inRange)) {
        let m = l.text.match(/^\[(.+?)\] retain (?:moving (\S+) (\S+) [\d.]+|label (\S+) (.+))/);
        if (m) {
            const cam = m[1];
            let ev = open.get(cam);
            if (!ev || l.t - ev.end > 60000) { // a new event after 60 s of nothing from this camera
                ev = { camera: cam, camId: camIdByName(cam), start: l.t, end: l.t, tracks: new Map(), faces: new Set() };
                open.set(cam, ev);
                events.push(ev);
            }
            ev.end = l.t;
            if (m[3]) { if (!ev.tracks.has(m[3])) ev.tracks.set(m[3], new Set()); ev.tracks.get(m[3]).add(m[2]); }
            else ev.faces.add(m[5].trim());
            continue;
        }
        m = l.text.match(/^sending encrypted push (\{.*)$/);
        if (m) {
            let j;
            try { j = JSON.parse(m[1]); } catch { continue; }
            pushes.push({ t: l.t, camId: j.data?.hash?.match(/timeline\/(\d+)/)?.[1], camera: j.title,
                subtitle: j.subtitle, to: j.data?.actionUrl?.split('/').pop(), silent: !!j.silent, used: false });
            continue;
        }
        // NVR's movement check: objects it doesn't consider moving are never notified
        m = l.text.match(/^\[(.+?)\] (?:(\S+) is stationary|Ignoring stationary (vehicle)|Ignoring (vehicle) motion due to (clipped) detection)/);
        if (m) { still.push({ t: l.t, camera: m[1], cls: m[2] || m[3] || m[4], clipped: !!m[5] }); continue; }
        // NVR's own lines only ("[Other Plugin] snoozing ..." comes from other notifiers)
        m = l.text.match(/^snoozing nvr-(\d+)-(.+)-(true|false) for (\d+) minutes/);
        if (m) { snoozes.push({ t: l.t, camId: m[1], type: m[2], minutes: Number(m[4]) }); continue; }
        if (/push error|"failureCount":[1-9]/.test(l.text)) errors.push(l);
    }

    // Object Detection's 10-second summaries: "[Camera] [12.5s] Detected (filtered)  : vehicle (0.93)"
    // list the classes its zones removed before NVR's notifier saw them. Only in a saved log
    // (`tail objectdetector`): in memory these lines have no usable times.
    const odLines = loadFileLines(path.join(outDir, 'objectdetector', 'plugin.log'));
    const filteredSummaries = [];
    for (const l of odLines ?? []) {
        const m = l.text.match(/^\[(.+?)\] \[[\d.]+s\] Detected \(filtered\)\s*: (.*)$/);
        if (m && !m[2].includes('[no detections]'))
            filteredSummaries.push({ t: l.t, camera: m[1], classes: [...m[2].matchAll(/(\S+) \(/g)].map(x => x[1]) });
    }
    const zonesByCam = Object.assign({}, ...devices.filter(d => d.detectionZones).map(d => d.detectionZones));
    let needOd = false;

    // per event: what the logs say happened to each notification type
    const evidenceFor = ev => {
        const near = x => x.camera === ev.camera;
        const odCovers = odLines?.length && odLines[0].t <= ev.start && odLines.at(-1).t >= ev.end;
        const stillHere = still.filter(x => near(x) && x.t >= ev.start - 1000 && x.t <= ev.end + 12000);
        // a summary at time T covers the 10 s before it
        const removed = new Set(filteredSummaries.filter(x => near(x) && x.t >= ev.start && x.t - 10500 <= ev.end).flatMap(x => x.classes));
        const zoneText = cls => {
            const zs = (zonesByCam[ev.camId] || []).filter(z => z.mode !== 'observe' && (!z.classes || z.classes.includes(cls)));
            const ex = zs.filter(z => z.mode === 'exclude').map(z => `"${z.name}"`), inc = zs.filter(z => z.mode !== 'exclude').map(z => `"${z.name}"`);
            if (ex.length) return `exclude zone ${ex.join(' or ')}`;
            if (inc.length) return `it was outside include zone ${inc.join(' or ')}`;
            return 'a zone';
        };
        return {
            any: stillHere.length > 0 || removed.size > 0,
            reasons(ty) {
                const out = [];
                for (const cls of removed) if (TYPE_OF_CLASS(cls) === ty) out.push(`Object Detection removed a ${cls} (${zoneText(cls)}), so NVR never got it`);
                const st = stillHere.filter(x => TYPE_OF_CLASS(x.cls) === ty);
                if (st.some(x => x.clipped))
                    out.push(`NVR couldn't measure the ${st[0].cls}'s movement (it logged "clipped detection": the object crossed the edge of a detection tile, or there was too much motion) and doesn't notify for objects it doesn't see moving`);
                else if (st.length) out.push(`NVR logged "${st[0].cls} is stationary" and doesn't notify for objects that aren't moving`);
                if (!odCovers && ['Vehicle', 'People', 'Animal'].includes(ty)) needOd = true;
                return out;
            },
        };
    };

    const rows = []; // {t, kind: 'event'|'settings'|'error', ...}

    for (const ev of events) {
        // what was detected, and which notification types that maps to
        const types = new Set();
        const parts = [];
        for (const [cls, ids] of ev.tracks) {
            const ty = TYPE_OF_CLASS(cls);
            if (ty) types.add(ty);
            parts.push(cls === 'person' ? (ids.size === 1 ? '1 person' : `${ids.size} people`) : `${ids.size} ${cls}${ids.size > 1 ? 's' : ''}`);
        }
        if (ev.faces.size) { types.add('Familiar People'); parts.push(`face${ev.faces.size > 1 ? 's' : ''}: ${[...ev.faces].join(', ')}`); }
        const settings = settingsAt(ev.start);
        const evPushes = pushes.filter(p => (p.camId ? p.camId === ev.camId : p.camera === ev.camera) && p.t >= ev.start - 5000 && p.t <= ev.end + 30000);
        evPushes.forEach(p => p.used = true);
        // snoozes from an earlier alert still running when this event began
        const snoozedTypes = new Set(snoozes.filter(s => s.camId === ev.camId && s.t < ev.start && s.t >= ev.start - s.minutes * 60000).map(s => s.type));
        const faceSeen = types.has('Familiar People');
        const detected = [...ev.tracks.keys()];
        const evidence = evidenceFor(ev);

        // a settings change whose uncertainty window (after, t] contains this detection
        const straddling = history.filter(h => h.after < ev.start && ev.start <= h.t).at(-1);

        const recipients = [];
        for (const [nid, s] of Object.entries(settings)) {
            const got = evPushes.filter(p => p.to === nid);
            const old = explainNotifier(s, ev.camId, types, snoozedTypes, faceSeen, ev.start, detected, evidence);
            if (got.length) {
                const subs = [...new Set(got.map(p => `"${p.subtitle}"`))].join(", ");
                recipients.push({ status: "sent", name: s.name, text: subs + (old.offText ? `; ${old.offText}` : "") });
                continue;
            }
            let { why } = old;
            // the change may have landed just before this detection: prefer the new settings if they explain the skip
            const ns = straddling?.notifiers?.[nid];
            if (old.unknown && ns) {
                const nu = explainNotifier(ns, ev.camId, types, snoozedTypes, faceSeen, ev.start, detected, evidence);
                if (!nu.unknown)
                    why = `${nu.why} (settings changed between ${fmtClock(straddling.after)} and ${fmtClock(straddling.t)}; this detection falls in that window)`;
            }
            recipients.push({ status: "skipped", name: s.name, text: why });
        }
        rows.push({ t: ev.start, kind: 'event', camera: ev.camera, what: parts.join(', ') || 'detection', recipients });
    }

    // pushes with no matching detection in the log (e.g. doorbell presses)
    const lone = new Map();
    for (const p of pushes.filter(p => !p.used)) {
        const k = `${p.camId}|${p.subtitle}|${Math.round(p.t / 10000)}`;
        if (!lone.has(k)) lone.set(k, { t: p.t, camera: p.camera, subtitle: p.subtitle, to: new Set() });
        lone.get(k).to.add(p.to);
    }
    for (const p of lone.values())
        rows.push({ t: p.t, kind: 'event', camera: p.camera, what: '(no detection logged)',
            recipients: [...p.to].map(id => ({ status: 'sent', name: byId.get(id)?.name ?? `device ${id}`, text: `"${p.subtitle}"` })) });

    // settings changes inside the window
    for (let i = 1; i < history.length; i++) {
        if (history[i].t < since || history[i].t > until) continue;
        // group identical changes: "Garage Front, Garage Back  custom notifications: none ... on <notifiers>"
        const groups = new Map();
        for (const c of settingsChanges(history[i - 1].notifiers, history[i].notifiers, camName)) {
            const g = groups.get(c.text) ?? { cameras: new Set(), notifiers: new Set() };
            if (c.camera) g.cameras.add(c.camera);
            g.notifiers.add(c.notifier);
            groups.set(c.text, g);
        }
        const merged = new Map(); // same cameras+text across notifiers
        for (const [text, g] of groups) {
            const k = [...g.cameras].join(', ') + '|' + text;
            const m = merged.get(k) ?? { cameras: [...g.cameras], text, notifiers: new Set() };
            g.notifiers.forEach(n => m.notifiers.add(n));
            merged.set(k, m);
        }
        if (merged.size)
            rows.push({ t: history[i].t, after: history[i].after, kind: 'settings', camera: [...merged.values()].flatMap(m => m.cameras).join(', '), what: '',
                recipients: [...merged.values()].map(m => ({ status: 'changed', name: m.cameras.join(', ') || 'all cameras', text: `${m.text} on ${[...m.notifiers].join(', ')}` })) });
    }

    for (const e of errors) rows.push({ t: e.t, kind: 'error', camera: '', what: 'push error', recipients: [{ status: 'error', name: '', text: e.text.slice(0, 200) }] });

    // print
    const shown = rows.filter(r => !cameraFilter || r.camera.toLowerCase().includes(cameraFilter.toLowerCase())).sort((a, b) => a.t - b.t);
    const color = process.stdout.isTTY;
    const c = (code, s) => color ? `\x1b[${code}m${s}\x1b[0m` : s;
    const statusColor = { sent: '32', skipped: '33', changed: '36', error: '31' };
    for (const r of shown) {
        const head = r.kind === 'settings'
            ? (r.t - r.after > 2000 ? `notification settings changed (sometime between ${fmtClock(r.after)} and ${fmtClock(r.t)})` : 'notification settings changed')
            : `${r.camera}${r.what ? ' — ' + r.what : ''}`;
        console.log(`${c('1', fmtTime(r.t))}  ${head}`);
        const w = Math.max(...r.recipients.map(x => x.name.length));
        for (const x of r.recipients)
            console.log(`    ${c(statusColor[x.status], x.status.padEnd(7))}  ${x.name.padEnd(w)}  ${x.text}`);
    }
    const first = nvr[0]?.t, last = nvr.at(-1)?.t;
    const notes = [`${shown.filter(r => r.kind === 'event').length} detection event(s).`];
    notes.push(approxNvr ? 'NVR log not saved, so the in-memory console was used (times are approximate). Run `tail nvr` to keep exact history.'
        : `NVR log covers ${first ? fmtTime(first) : '?'} – ${last ? fmtTime(last) : '?'}; times when tail wasn't running are missing.`);
    if (usedCurrent) notes.push(history.length
        ? `Settings before ${fmtTime(history[0].t)} weren't recorded, so skip reasons before then use the current settings and may not match what was set at the time.`
        : 'Notification settings history isn\'t recorded yet (it starts when you run `tail nvr`), so skip reasons use the current settings and may not match what was set at the time.');
    if (needOd) notes.push('Object Detection log not saved for some of these events, so skips caused by its zones can\'t be shown for them. Run `tail nvr objectdetector` to include them.');
    console.error('\n' + notes.join('\n'));
}

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
const flag = n => { const i = rest.indexOf(n); if (i < 0) return; const v = rest[i + 1]; rest.splice(i, 2); return v; };

if (cmd === 'list') {
    const [ports, devices] = await Promise.all([discoverPorts(), readDevices()]);
    const pluginIds = [...new Set([...ports.keys(), ...devices.map(d => d.pluginId)])].sort();
    for (const p of pluginIds) {
        console.log(`${p}  (${shortName(p)})  ${ports.has(p) ? `port ${ports.get(p)}` : 'not running'}`);
        for (const d of devices.filter(d => d.pluginId === p && d.nativeId != null && !/^(Internal|API|Builtin)$/.test(d.type)))
            console.log(`    ${d.name.padEnd(32)} id ${d.id.padEnd(4)} ${d.type.padEnd(12)} nativeId ${d.nativeId}`);
    }
    console.log(`\nports change on restart; tail by name, e.g.: node scrypted-logs.mjs tail hikvision "Front Porch"`);
}
else if (cmd === 'tail') {
    const outDir = flag('--dir') || path.join(os.homedir(), 'Library', 'Logs', 'Scrypted', 'consoles');
    // echo to the terminal when run interactively; stay quiet under nohup/launchd
    const toStdout = rest.includes('--stdout') || (process.stdout.isTTY && !rest.includes('--quiet'));
    const args = rest.filter(a => a !== '--stdout' && a !== '--quiet');
    if (!args.length) { console.error('tail: name a plugin or device, or --all'); process.exit(1); }
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

    // one shared, rate-limited port lookup for all tails (ports move on restart)
    let cache = { at: 0, ports: new Map(), pending: null };
    const getPorts = async () => {
        if (Date.now() - cache.at < 3000) return cache.ports;
        cache.pending ??= discoverPorts().catch(() => new Map()).then(p => { cache = { at: Date.now(), ports: p, pending: null }; return p; });
        return cache.pending;
    };

    const [ports, devices] = await Promise.all([getPorts(), readDevices()]);
    const targets = resolveTargets(args, devices, ports);
    for (const t of targets)
        console.error(`tailing ${t.label}  (${t.pluginId}${t.nativeId != null ? ` nativeId ${t.nativeId}` : ''})\n    -> ${path.join(outDir, t.file)}`);
    console.error(toStdout ? '(also printing here; --quiet to only write files)' : '(writing files only; --stdout to also print here)');
    const jobs = targets.map(t => tail(t, outDir, toStdout, getPorts));
    if (targets.some(t => t.pluginId === '@scrypted/nvr')) {
        console.error(`recording NVR notifier settings changes -> ${path.join(outDir, SETTINGS_FILE)}`);
        jobs.push(recordNotifierSettings(outDir, devices));
    }
    await Promise.all(jobs);
}
else if (cmd === 'grep') {
    const context = Number(flag('-C') ?? 0);
    const ignoreCase = rest.includes('-i');
    const [pattern, ...args] = rest.filter(a => a !== '-i');
    if (!pattern) { console.error('grep: give a pattern (regex), e.g. grep -i "rtsp|timeout" hikvision'); process.exit(1); }
    const re = new RegExp(pattern, ignoreCase ? 'i' : '');
    const color = process.stdout.isTTY;
    const hl = s => color ? s.replace(new RegExp(pattern, ignoreCase ? 'gi' : 'g'), m => `\x1b[1;31m${m}\x1b[0m`) : s;
    let total = 0;
    for (const t of await readTargets(args)) {
        if (!t.text) continue;
        const lines = [...timedLines(t.text)];
        const hits = lines.map((l, i) => re.test(l.line) ? i : -1).filter(i => i >= 0);
        if (!hits.length) continue;
        total += hits.length;
        console.log(`${color ? '\x1b[1m' : ''}== ${t.label}  (${t.pluginId})  ${hits.length} match${hits.length === 1 ? '' : 'es'}${color ? '\x1b[0m' : ''}`);
        const show = new Set(hits.flatMap(i => Array.from({ length: 2 * context + 1 }, (_, k) => i - context + k)).filter(i => i >= 0 && i < lines.length));
        let prev = -2;
        for (const i of [...show].sort((a, b) => a - b)) {
            if (context && i !== prev + 1 && prev >= 0) console.log('--');
            const { when, line } = lines[i];
            console.log(`${when ? `~${when}` : ''}${hits.includes(i) ? ': ' : '- '}${hl(line)}`);
            prev = i;
        }
    }
    console.error(`${total} matching line${total === 1 ? '' : 's'} (in-memory buffers only; ~time = last 5-minute marker)`);
}
else if (cmd === 'dump') {
    if (!rest.length) { console.error('dump: name a plugin or device, or --all'); process.exit(1); }
    for (const t of await readTargets(rest)) {
        if (!t.text) continue;
        console.log(`==== ${t.label}  (${t.pluginId}${t.nativeId != null ? ` nativeId ${t.nativeId}` : ''})`);
        process.stdout.write(t.text.endsWith('\n') ? t.text : t.text + '\n');
    }
}
else if (cmd === 'notifications') {
    const outDir = flag('--dir') || path.join(os.homedir(), 'Library', 'Logs', 'Scrypted', 'consoles');
    const since = parseTime(flag('--since'), Date.now() - 24 * 3600 * 1000);
    const until = parseTime(flag('--until'), Infinity);
    await notificationsReport({ outDir, since, until, cameraFilter: rest[0] });
}
else {
    console.log(`usage:
  node scrypted-logs.mjs list
  node scrypted-logs.mjs tail <plugin|device> [...] [--quiet|--stdout] [--dir <path>]
    (prints to the terminal when interactive; --quiet writes files only)
  node scrypted-logs.mjs tail --all
  node scrypted-logs.mjs grep <regex> [plugin|device ...] [-i] [-C n]   search in-memory consoles (default: all)
  node scrypted-logs.mjs dump <plugin|device ...|--all>                print in-memory consoles once
  node scrypted-logs.mjs notifications [camera] [--since 15:50] [--until 16:30] [--dir <path>]
    which NVR pushes were sent or skipped per device, and why. Needs \`tail nvr objectdetector\` running
    beforehand: it saves both consoles and records notification settings changes. Without it, only
    the in-memory NVR console is used, with approximate times and the current settings.
plugins match by id or short name (hikvision, @scrypted/nvr); devices by name, substring, id, or nativeId.`);
}
