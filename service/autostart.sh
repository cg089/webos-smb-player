#!/bin/sh
# SMB Player: HTTP-/SMB-Server im Hintergrund starten (optional, nur gerootete TVs).
# Wird beim Systemstart vom Homebrew Channel aus /var/lib/webosbrew/init.d aufgerufen,
# kann aber auch von Hand per SSH gestartet werden:  sh autostart.sh
SVC=org.smbstream.app.service

# Dienstverzeichnis suchen (per SMBSTREAM_SVC_DIR ueberschreibbar)
DIR="$SMBSTREAM_SVC_DIR"
if [ -z "$DIR" ]; then
  for base in /media/developer/apps/usr/palm/services /media/cryptofs/apps/usr/palm/services /usr/palm/services; do
    if [ -f "$base/$SVC/server.js" ]; then DIR="$base/$SVC"; break; fi
  done
fi
if [ -z "$DIR" ] || [ ! -f "$DIR/server.js" ]; then
  echo "smbstream: Dienstverzeichnis nicht gefunden" >&2
  exit 0
fi

# Node-Programm suchen
NODE=""
for n in "$(command -v node 2>/dev/null)" /usr/bin/node /usr/bin/nodejs /usr/local/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then NODE="$n"; break; fi
done
if [ -z "$NODE" ]; then
  echo "smbstream: kein Node gefunden" >&2
  exit 0
fi

# Gleiches Datenverzeichnis wie der webOS-Service, damit beide dieselbe Konfiguration sehen
export SMBSTREAM_DATA="${SMBSTREAM_DATA:-$DIR/data}"
LOGDIR="$SMBSTREAM_DATA"
mkdir -p "$LOGDIR" 2>/dev/null
LOG="$LOGDIR/server.log"
# Log klein halten
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then mv "$LOG" "$LOG.old"; fi

cd "$DIR" || exit 0
# Laeuft der Server schon, beendet sich der zweite Start von selbst (Port belegt).
# --expose-gc: Node 0.12 raeumt Buffer sonst zu spaet auf (TV hat nur ~860 MB RAM)
nohup "$NODE" --expose-gc "$DIR/server.js" >> "$LOG" 2>&1 &
exit 0
