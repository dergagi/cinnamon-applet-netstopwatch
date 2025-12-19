const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;

function readText(path) {
  try {
    let [ok, bytes] = GLib.file_get_contents(path);
    if (!ok) return null;
    return String(bytes).trim();
  } catch (e) {
    return null;
  }
}

function listNetIfaces(showAll) {
  let dir = GLib.Dir.open("/sys/class/net", 0);
  let names = [];
  let n;
  while ((n = dir.read_name()) !== null) {
    if (!n || n === "lo") continue;

    if (showAll) {
      names.push(n);
      continue;
    }

    const okPrefix = /^(en|eth|wl|wlan|wlp|tailscale|ppp|bond|team)/.test(n);
    const badPrefix = /^(veth|br-|docker|virbr|hassio)/.test(n);

    const oper = readText(`/sys/class/net/${n}/operstate`) || "";
    const isUp = (oper === "up" || oper === "unknown");

    if (badPrefix) continue;
    if (okPrefix || isUp) names.push(n);
  }
  names.sort();
  return names;
}

function getDefaultIface() {
  let txt = readText("/proc/net/route");
  if (!txt) return "enp0s31f6";
  let lines = txt.split("\n");
  for (let i = 1; i < lines.length; i++) {
    let cols = lines[i].trim().split(/\s+/);
    if (cols.length < 2) continue;
    if (cols[1] === "00000000") return cols[0];
  }
  return "enp0s31f6";
}

function readIfaceBytes(iface) {
  let rx = readText(`/sys/class/net/${iface}/statistics/rx_bytes`);
  let tx = readText(`/sys/class/net/${iface}/statistics/tx_bytes`);
  if (rx === null || tx === null) return null;
  let rxn = Number(rx);
  let txn = Number(tx);
  if (!Number.isFinite(rxn) || !Number.isFinite(txn)) return null;
  return { rx: rxn, tx: txn };
}

function fmtBitsPerSec(bps) {
  let mbit = (bps * 8) / 1e6;
  if (mbit >= 100) return `${mbit.toFixed(0)} Mbit/s`;
  if (mbit >= 10)  return `${mbit.toFixed(1)} Mbit/s`;
  return `${mbit.toFixed(2)} Mbit/s`;
}

function fmtBytes(bytes) {
  const units = ["B","KB","MB","GB","TB","PB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 10 || u === 0 ? 0 : 2)} ${units[u]}`;
}

class NetStopwatch extends Applet.TextIconApplet {
  constructor(metadata, orientation, panelHeight, instanceId) {
    super(orientation, panelHeight, instanceId);

    this.cacheFile = GLib.build_filenamev([GLib.get_user_cache_dir(), "netstopwatch@store2.json"]);

    this.showAllIfaces = false;
    this.bases = {};      // iface -> {rx,tx,epoch}
    this.iface = getDefaultIface();

    this.last = null;
    this.lastTs = null;

    this.menuManager = new PopupMenu.PopupMenuManager(this);
    this.menu = new Applet.AppletPopupMenu(this, orientation);
    this.menuManager.addMenu(this.menu);

    this.set_applet_icon_symbolic_name("network-transmit-receive-symbolic");
    this.set_applet_tooltip("Net Traffic Stopwatch");

    this.loadState();
    if (!this.getBase(this.iface)) this.resetSession(true);

    this.rebuildContextMenu();

    this._timer = Mainloop.timeout_add_seconds(1, () => this.tick());
    this.tick();
  }

  getBase(iface) {
    return (this.bases && this.bases[iface]) ? this.bases[iface] : null;
  }

  setBase(iface, base) {
    this.bases[iface] = base;
  }

  rebuildContextMenu() {
    this._applet_context_menu.removeAll();

    // Marker: daran erkennst du sofort, dass V2 läuft:
    this._applet_context_menu.addAction("NetStopwatch v2", () => {});

    this._applet_context_menu.addAction(`Reset Session (${this.iface})`, () => this.resetSession());

    let sub = new PopupMenu.PopupSubMenuMenuItem(`Interface wählen (aktuell: ${this.iface})`);
    let ifs = listNetIfaces(this.showAllIfaces);
    if (ifs.length === 0) {
      sub.menu.addMenuItem(new PopupMenu.PopupMenuItem("Keine Interfaces gefunden"));
    } else {
      for (let i = 0; i < ifs.length; i++) {
        let n = ifs[i];
        let it = new PopupMenu.PopupMenuItem(n + (n === this.iface ? "  ✓" : ""));
        it.connect("activate", () => this.setIface(n));
        sub.menu.addMenuItem(it);
      }
    }
    this._applet_context_menu.addMenuItem(sub);

    this._applet_context_menu.addAction(
      this.showAllIfaces ? "Nur normale Interfaces anzeigen" : "Alle Interfaces anzeigen (Docker/veth/bridges)",
      () => { this.showAllIfaces = !this.showAllIfaces; this.saveState(); this.rebuildContextMenu(); }
    );

    this._applet_context_menu.addAction("Interface neu erkennen", () => this.reDetectIface());
  }

  setIface(n) {
    if (!n) return;
    this.iface = n;
    this.last = null;
    this.lastTs = null;

    if (!this.getBase(this.iface)) this.resetSession(true);

    this.saveState();
    this.rebuildContextMenu();
    this.tick();
  }

  reDetectIface() {
    this.setIface(getDefaultIface());
  }

  resetSession(silent=false) {
    let cur = readIfaceBytes(this.iface);
    if (!cur) return;

    this.setBase(this.iface, {
      rx: cur.rx,
      tx: cur.tx,
      epoch: Math.floor(Date.now() / 1000)
    });

    this.last = cur;
    this.lastTs = Date.now();

    this.saveState();
    if (!silent) this.tick();
  }

  loadState() {
    let txt = readText(this.cacheFile);
    if (!txt) return;
    try {
      let s = JSON.parse(txt);
      if (s && typeof s === "object") {
        if (typeof s.showAllIfaces === "boolean") this.showAllIfaces = s.showAllIfaces;
        if (s.bases && typeof s.bases === "object") this.bases = s.bases;

        if (typeof s.iface === "string") {
          if (GLib.file_test(`/sys/class/net/${s.iface}`, GLib.FileTest.IS_DIR)) {
            this.iface = s.iface;
          }
        }
      }
    } catch (e) {}
  }

  saveState() {
    try {
      let s = {
        iface: this.iface,
        showAllIfaces: this.showAllIfaces,
        bases: this.bases
      };
      GLib.file_set_contents(this.cacheFile, JSON.stringify(s));
    } catch (e) {}
  }

  on_applet_clicked() {
    this.menu.removeAll();

    let cur = readIfaceBytes(this.iface);
    let base = this.getBase(this.iface);

    if (!cur || !base) {
      this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Interface ${this.iface} nicht lesbar.`));
      this.menu.toggle();
      return;
    }

    let baseStr = GLib.DateTime.new_from_unix_local(base.epoch).format("%Y-%m-%d %H:%M:%S");
    let sessRx = Math.max(0, cur.rx - base.rx);
    let sessTx = Math.max(0, cur.tx - base.tx);
    let sessTot = sessRx + sessTx;

    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Interface: ${this.iface}`));
    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Session seit: ${baseStr}`));
    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Session RX: ${fmtBytes(sessRx)}`));
    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Session TX: ${fmtBytes(sessTx)}`));
    this.menu.addMenuItem(new PopupMenu.PopupMenuItem(`Session Total: ${fmtBytes(sessTot)}`));
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    let resetItem = new PopupMenu.PopupMenuItem("Reset Session (Start bei 0)");
    resetItem.connect("activate", () => this.resetSession());
    this.menu.addMenuItem(resetItem);

    this.menu.toggle();
  }

  tick() {
    let cur = readIfaceBytes(this.iface);
    let now = Date.now();

    if (!cur) {
      this.set_applet_label(`↓ ? ↑ ?`);
      return true;
    }

    if (!this.last) {
      this.last = cur;
      this.lastTs = now;
      return true;
    }

    let dt = Math.max(0.5, (now - this.lastTs) / 1000.0);
    let drx = Math.max(0, cur.rx - this.last.rx);
    let dtx = Math.max(0, cur.tx - this.last.tx);

    let downBps = drx / dt;
    let upBps = dtx / dt;

    this.set_applet_label(`↓ ${fmtBitsPerSec(downBps)}  ↑ ${fmtBitsPerSec(upBps)}`);

    let base = this.getBase(this.iface);
    if (base) {
      let sessRx = Math.max(0, cur.rx - base.rx);
      let sessTx = Math.max(0, cur.tx - base.tx);
      let sessTot = sessRx + sessTx;
      let baseStr = GLib.DateTime.new_from_unix_local(base.epoch).format("%Y-%m-%d %H:%M:%S");
      this.set_applet_tooltip(
        `Interface: ${this.iface}\n` +
        `Session seit: ${baseStr}\n` +
        `Session RX: ${fmtBytes(sessRx)}\n` +
        `Session TX: ${fmtBytes(sessTx)}\n` +
        `Session Total: ${fmtBytes(sessTot)}`
      );
    }

    this.last = cur;
    this.lastTs = now;
    return true;
  }

  on_applet_removed_from_panel() {
    if (this._timer) Mainloop.source_remove(this._timer);
  }
}

function main(metadata, orientation, panelHeight, instanceId) {
  return new NetStopwatch(metadata, orientation, panelHeight, instanceId);
}
