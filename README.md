# SMB Player für LG webOS

Spielt Filme von SMB-Freigaben (NAS, Windows-Freigabe, Samba) direkt auf dem LG-Fernseher ab.
Die Freigaben richtest du bequem im Browser am PC oder Handy ein. Die Konfiguration bleibt lokal auf dem Fernseher.

Entwickelt für einen **LG 75UK6200PLB** (webOS 4.x, gerootet). Läuft grundsätzlich auch auf neueren webOS-Versionen.

**Fertige Datei:** `dist/org.smbstream.app_1.0.0_all.ipk`

## Installation

**Mit dem webOS Dev Manager (am einfachsten):** den Fernseher dort hinzufügen und die IPK über die Installationsfunktion einspielen. Danach ist „SMB Player" im Launcher.

**Mit der LG-Kommandozeile** (`npm install -g @webos-tools/cli`):

```bash
ares-setup-device                      # TV einmalig anlegen (Name z. B. "tv", Developer Mode aktiv)
ares-install --device tv dist/org.smbstream.app_1.0.0_all.ipk
ares-launch  --device tv org.smbstream.app
```

## Einrichtung

1. **App starten.** Beim ersten Start zeigt sie die Adresse der Einrichtungsseite, z. B. `http://192.168.1.50:8765/`.
2. Diese Adresse **am PC oder Handy im Browser** öffnen (gleiches Netzwerk).
3. „Freigabe hinzufügen": Server (Name oder IP), Freigabename, Benutzer und Passwort eintragen. Mit **„Verbindung testen"** prüfen, dann speichern.
4. Am Fernseher **OK** drücken. Die Freigabe erscheint, und es kann losgehen.

Es lassen sich beliebig viele Freigaben anlegen. Optional kann ein Startordner in der Freigabe festgelegt werden (z. B. nur `Filme`).

## Bedienung am Fernseher

| Taste | Liste | Player |
|---|---|---|
| ▲ ▼ | Auswahl | ▲ +60 s, ▼ −60 s |
| ◀ ▶ | | −10 s / +10 s |
| OK | Öffnen / Abspielen | Play/Pause |
| Zurück | Eine Ebene höher, ganz oben: App beenden | Player schließen |
| Play / Pause / Stop | | wie üblich |
| ⏪ / ⏩ | | −30 s / +30 s |
| Rot | | Von vorn starten |
| Gelb (Startseite) | Freigaben neu laden | |
| CH ▲ ▼ | 8 Zeilen springen | |

* Die **Abspielposition** wird gespeichert; beim nächsten Start geht es automatisch dort weiter.
* Nach dem Ende einer Datei startet automatisch die **nächste Datei im Ordner** (praktisch für Serien).
* Magic Remote: Klicken und Mausrad funktionieren in den Listen.

## Wie es funktioniert

Eine webOS-App läuft im Browser und kann kein SMB. Deshalb besteht das Paket aus zwei Teilen:

* **App** (`app/`): Oberfläche und Player (HTML/JS, ES5, für Chromium 53).
* **Service** (`service/`): Node.js-Dienst auf dem Fernseher. Er spricht SMB (eigener, abhängigkeitsfreier SMB2-Client mit NTLMv2 und Signierung) und stellt die Dateien per HTTP mit Range-Unterstützung unter `http://127.0.0.1:8765/stream` bereit. Der `<video>`-Player des Fernsehers spielt diese Adresse ab, es decodiert also die Hardware des TVs. Derselbe Dienst liefert die Einrichtungsseite (Port **8765**).

Die Konfiguration liegt in `/media/developer/apps/usr/palm/services/org.smbstream.app.service/data/config.json` (nur für den Besitzer lesbar). Die Passwörter stehen dort im Klartext, weil die SMB-Anmeldung sie braucht.

**Wichtig bei App-Updates:** Das Installieren einer neuen IPK ersetzt den Dienstordner und damit auch die Konfiguration. Vorher sichern, danach zurückkopieren (per SSH auf dem TV):

```bash
cp /media/developer/apps/usr/palm/services/org.smbstream.app.service/data/config.json /media/developer/smbstream-config-backup.json
```

Der Dienst läuft auf dem TV in einem abgeschotteten Bereich (Jail) und kann nur in seinem eigenen Ordner schreiben. Deshalb liegt die Konfiguration dort.

## Optional: Dienst immer laufen lassen (nur gerootete TVs)

Die App startet den Dienst bei Bedarf selbst. Damit die Einrichtungsseite auch **ohne geöffnete App** erreichbar ist, kann der Server beim Fernseher-Start mitlaufen. Einmalig per SSH auf dem TV:

```bash
printf '#!/bin/sh\nexec sh /media/developer/apps/usr/palm/services/org.smbstream.app.service/autostart.sh\n' > /var/lib/webosbrew/init.d/90-smbstream
chmod +x /var/lib/webosbrew/init.d/90-smbstream
```

Sofort starten (ohne Neustart): `sh /media/developer/apps/usr/palm/services/org.smbstream.app.service/autostart.sh`. Das Log liegt in `.../org.smbstream.app.service/data/server.log`. Dieselbe Konfiguration wird in beiden Betriebsarten verwendet.

## Zugriffsschutz

Ohne Passwort kann **jedes Gerät im Heimnetz** die Einrichtungsseite öffnen und über `/stream` auf die Freigaben zugreifen. Unter „Zugriffsschutz" in der Einrichtungsseite lässt sich ein Passwort setzen. Es gilt für alle Zugriffe von anderen Geräten, der Fernseher selbst braucht es nicht. Außerdem lassen sich Einstellungen nur von der Seite selbst aus ändern, nicht von fremden Webseiten.

## Grenzen

* **SMB 2.0.2 / 2.1** (Windows 7 und neuer, Samba, die meisten NAS). **SMB 3-Pflicht** (Server mit „Minimum SMB3" oder erzwungener Verschlüsselung) wird nicht unterstützt, SMB 1 ebenfalls nicht. Meldet der Verbindungstest, dass der Server „SMB 2.x nicht unterstützt", muss am Server SMB 2.1 erlaubt werden.
* Ob ein Film läuft, entscheidet der Fernseher: HEVC/H.264/MKV/MP4 sind meist kein Problem. Manche Tonspuren (z. B. DTS) und Untertitel in der Datei werden von webOS 4 nicht immer unterstützt. Externe Untertitel-Dateien (`.srt`) werden **nicht** geladen.
* Es gibt keine Transkodierung: Der Fernseher bekommt die Datei unverändert.
* Der TV hat wenig Arbeitsspeicher (~860 MB) und läuft mit Node 0.12. Der Dienst startet den Server deshalb mit `--expose-gc` und räumt beim Streamen selbst auf. Der Speicherbedarf bleibt dadurch bei ca. 40 MB.

## Selbst bauen

```bash
tools/build.sh
```

Braucht Node.js. Das Skript nutzt `ares-package` bzw. `npx @webos-tools/cli`.

## Was getestet wurde (und was nicht)

**Getestet** (am PC, gegen einen unabhängigen SMB2-Server mit NTLMv2-Anmeldung):
Anmeldung inkl. falscher Zugangsdaten und falschem Freigabenamen, Ordnerlisten (auch Umlaute), Streaming mit Range-Anfragen (Bytevergleich per Hash, 40 MB mit ~80 MB/s), parallele Streams, Abbruch mitten im Transfer, SMB-Signierung, Pfad-Traversal-Schutz, Zugriffsschutz, Einrichtungsseite, die komplette TV-App in einem Browser (Navigation, Wiedergabe eines MP4 mit `moov` am Ende, Springen, Fortsetzen, nächste Folge, Fehlerfall), Paketstruktur per `ares-package --check`. Der Code besteht eine ES5-Syntaxprüfung.

**Auf dem TV getestet** (75UK6200PLB, webOS 4.4.3, Node 0.12.2): Installation, Start des Dienstes über Luna, Einrichtungsseite, SMB-Anmeldung inkl. Fehlerfälle, Streaming mit Range-Anfragen (bytegleich), stabiler Speicherbedarf über mehrere 40-MB-Streams. Der SMB-Server lief dabei auf einem anderen Rechner und war über einen SSH-Tunnel angebunden, weil sich TV und PC im Netzwerk nicht sehen.

**Noch nicht getestet:** die Wiedergabe über den webOS-Player (Codecs, Springen), die Anmeldung an deinem konkreten NAS bzw. Server, der Durchsatz im normalen Heimnetz (die gemessenen ~5 MB/s stammen vom SSH-Tunnel und sind nicht aussagekräftig), das Startskript auf dem TV.

Die Tests liegen in `test/smb-smoke.js` (benötigt einen erreichbaren SMB-Server, Aufruf siehe Dateikopf).

## Fehlersuche

* **„Dienst nicht erreichbar"** in der App: Der Dienst konnte nicht starten. Per SSH `sh .../autostart.sh` ausführen und `server.log` ansehen. Läuft `node` dort nicht, zeigt das Log den Grund (zu altes Node?).
* **Einrichtungsseite nicht erreichbar:** Die Adresse steht in der App (Startseite, unten). TV und PC müssen im selben Netz sein. Der Port 8765 darf nicht blockiert sein.
* **Anmeldung schlägt fehl:** Benutzer und Passwort prüfen. Bei Windows-Domänen die Domäne eintragen oder `DOMAIN\benutzer` als Benutzername verwenden.
