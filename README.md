# Net Traffic Stopwatch (netstopwatch@store2)

Session-Traffic (resetbar) + Interface-Auswahl via /sys rx_bytes/tx_bytes

## What it does

- Shows session network traffic (RX/TX) as a “stopwatch”
- Reset session counters from the applet menu
- Select network interface (based on /sys/class/net/* statistics)

## Install (local)

1. Copy the applet directory into your Cinnamon applets folder:

    mkdir -p ~/.local/share/cinnamon/applets
    cp -a netstopwatch@store2 ~/.local/share/cinnamon/applets/

2. Restart Cinnamon (or log out/in):

    cinnamon --replace

3. Add the applet to a panel via Cinnamon settings.

## Notes

- Reads RX/TX bytes via:
  /sys/class/net/<iface>/statistics/rx_bytes
  /sys/class/net/<iface>/statistics/tx_bytes
