# Memory Forget: Bedienungsanleitung

Mit **Memory Forget** entfernst du eine einzelne, sichtbare Memory kontrolliert aus dem lokalen Markdown-Memory-Corpus. Vor dem ersten Schreibzugriff zeigt die App alle gefundenen Quellen an. Erst **Apply Forget plan** führt den bestätigten Plan aus. **Forget project…** bietet zusätzlich eine reine Projektvorschau; sie führt noch keine Löschung aus.

## Wo finde ich die Funktion?

1. Öffne links **Markdown memory**.
2. Wähle in der Dateiliste **`memory_summary.md`**.
3. Wechsle oberhalb des Dokuments von **Edit** zu **Preview**.
4. Klicke hinter dem gewünschten Summary-Eintrag auf **Forget…**.

Der Button erscheint nur bei obersten Markdown-Listeneinträgen, die mit `- ` beginnen. Er ist außerdem nur in `memory_summary.md`, in der Preview und ohne ungespeicherte Editor-Änderungen verfügbar.

Das vollständige Löschen einer Markdown-Datei ist im normalen Memory-Editor absichtlich nicht verfügbar: Es könnte Querverweise und Provenienz unterbrechen, ohne andere Kopien derselben Memory zu entfernen. **Forget…** ist der einzige reguläre Löschweg.

## 1. Den Löschplan prüfen

Nach **Forget…** öffnet sich der Dialog **Forget this Memory?**. Das Erstellen dieser Vorschau verändert noch keine Datei.

Der Dialog zeigt:

- **Selected summary entry:** die ausgewählte Memory.
- **Confirm the durable sources:** mögliche Entsprechungen in `MEMORY.md`, wenn die Zuordnung mehrdeutig oder nur ähnlich ist.
- **Matched by:** die lokalen, deterministischen Signale für einen Treffer, beispielsweise normalisierter Text, Task-Verweis oder Ad-hoc-Markierung.
- **Exact affected sections:** jeden Abschnitt, den der aktuelle Plan verändern würde, einschließlich Dateipfad und Zeilenbereich.

Bei genau einem eindeutigen Treffer wird die dauerhafte Quelle automatisch bestätigt. Bei mehreren oder nur ähnlichen Treffern:

1. Markiere ausschließlich die passende Quelle oder die passenden Quellen.
2. Klicke **Update plan**.
3. Prüfe die neu berechnete Liste unter **Exact affected sections**.

Kann die App keinen sicheren Plan bilden, erklärt sie den Grund und deaktiviert **Apply Forget plan**. **Close** beendet die Vorschau ohne Änderungen.

Die Zuordnung läuft vollständig lokal und regelbasiert. Es wird kein externes Modell aufgerufen und keine freie semantische Entscheidung an eine KI delegiert.

## Projektvorschau mit Forget project…

Öffne **Markdown memory** und klicke oben auf **Forget project…**. Im Feld **Project directory** kannst du ein bekanntes Verzeichnis auswählen oder einen absoluten Pfad eingeben. **Preview project** erstellt die Vorschau; **Refresh preview** berechnet sie erneut und **Cancel** schließt sie. Ungespeicherte Editor-Änderungen sperren den Einstieg.

Die Vorschau umfasst das ausgewählte Verzeichnis und seine echten Unterverzeichnisse: `/work/app` schließt `/work/app/packages/ui` ein, aber nicht `/work/application`. Projektbelege stammen ausschließlich aus `applies_to: cwd=…` der dauerhaften Task Groups und `session_meta` der aktiven oder archivierten Sessions. Freie Pfadnennungen sind keine Projektzuordnung.

Angezeigt werden die exakten betroffenen Markdown-Abschnitte mit Zeilenbereichen, Quelldateien, vollständige passende `stage1_outputs`-Zeilen, gemeinsam genutzte Memories, die bleiben, sowie die Zahl unverändert bleibender Sessions. Ein Summary-Eintrag bleibt erhalten, solange eine dauerhafte Quelle außerhalb des gewählten Verzeichnisses besteht. Nur ähnliche Texte, fehlende Quellen oder widersprüchliche Projektbelege erzeugen einen ausdrücklichen Blocker. Ungültige Pfade, leere Treffer und Ziele über alle projektbezogenen Task Groups sind ebenfalls nicht ausführbar.

Als aktiver Memory-Speicher gilt die einzige Datei `memories_<Version>.sqlite` direkt im konfigurierten `CODEX_HOME`. Mehrere passende Dateien blockieren die Vorschau; Entwicklungs- und Snapshot-Datenbanken werden nicht verwendet. Die App liest eine kurzlebige private Kopie einschließlich WAL und entfernt sie danach. Dadurch bleiben auch die SQLite-WAL-Nebendateien des Originals unverändert. Ändert sich die Datenbank während des Kopierens, muss die Vorschau erneuert werden.

In der Projektvorschau gibt es noch keinen Apply-Button. Markdown-Corpus, aktive Datenbank, Session-JSONL, Scheduler-Jobs und vorhandene Datenbank-Snapshots bleiben unverändert. Die Einzel-Memory-Funktion und die separate erweiterte Orphan-Bereinigung stehen weiterhin zur Verfügung.

## 2. Den bestätigten Plan anwenden

Klicke erst nach der Prüfung auf **Apply Forget plan**. Die App führt dann folgende Schritte aus:

1. Sie prüft die Hashes aller geplanten Dateien erneut. Eine zwischen Vorschau und Anwendung veränderte Datei stoppt den Vorgang.
2. Sie legt außerhalb des Memory-Corpus ein Backup der Originaldateien und ein `manifest.json` an. Beim Standardpfad `~/.codex/memories` liegt der Backup-Bereich unter `~/.codex/memory-forget-backups`.
3. Sie entfernt nur die bestätigten Abschnitte und erhält benachbarte, nicht zugehörige Inhalte.
4. Sie schreibt einen Delete-Tombstone.
5. Sie prüft unmittelbar, ob noch eine positive Kopie der Memory gefunden wird.

Session-Dateien unter `~/.codex/sessions` gehören nie zum Löschplan und bleiben unverändert. Schlägt ein Schreibschritt fehl, versucht die App alle bereits geschriebenen Dateien auf den gesicherten Stand zurückzusetzen. Das Manifest dokumentiert, ob der Vorgang abgeschlossen oder zurückgerollt wurde.

Nach erfolgreicher Anwendung zeigt der Dialog:

- alle veränderten Dateien,
- den Pfad des Tombstones,
- den Pfad des Backup-Manifests.

## Was ist ein Tombstone?

Ein **Tombstone** ist ein absichtlich verbleibender Löschvermerk. Der Begriff kommt aus Datenbanken und verteilten Systemen: Statt so zu tun, als hätte ein Datensatz nie existiert, bleibt eine kleine Markierung zurück, die sagt: **„Diese konkrete Information wurde bewusst gelöscht.“**

Der Codex Explorer speichert dafür sinngemäß folgenden Eintrag:

```markdown
# Delete memory

- action: delete
  codex-explorer-forget: sha256:<fingerprint>
  memory: <gelöschte Memory>
```

Dieser Eintrag ist keine weiterhin gültige positive Memory. Seine Bestandteile haben jeweils einen klaren Zweck:

- `action: delete` hält die Löschabsicht ausdrücklich fest.
- Der SHA-256-Fingerprint identifiziert genau diese Memory und verhindert doppelte Tombstones.
- `memory:` dokumentiert, auf welche Information sich die Löschabsicht bezieht.

Existiert bereits eine verknüpfte Ad-hoc-Note, entfernt die App daraus die positive Memory und übernimmt diese Note als Tombstone-Datei; nicht zugehöriger Inhalt bleibt erhalten. Andernfalls erzeugt sie genau eine neue Datei unter `extensions/ad_hoc/notes/`.

Der manuelle Recheck ignoriert den Tombstone selbst, weil dessen Text nur die Löschabsicht dokumentiert. Er sucht weiterhin nach positiven Kopien derselben oder einer ausreichend ähnlichen Memory.

Der Tombstone ist eine Schutz- und Audit-Markierung des Codex Explorers. Er ist **keine Garantie**, dass jede zukünftige Codex-Version oder jeder externe Konsolidierungsprozess diese Markierung versteht. Deshalb gibt es zusätzlich den manuellen Recheck.

## 3. Später erneut prüfen

Nach erfolgreicher Anwendung steht **Recheck now** zur Verfügung.

- **No positive copy currently appears in the Memory corpus.** bedeutet: Im aktuellen Markdown-Corpus wurde keine positive Kopie gefunden.
- **Memory resurfaced in …** bedeutet: Die Memory oder eine ausreichend ähnliche Formulierung ist wieder aufgetaucht; die genannten Dateien sollten erneut geprüft werden.

Der Recheck läuft ausschließlich auf Anforderung. Es gibt keinen Hintergrund-Watcher und keine automatische spätere Löschung.

## Wenn etwas nicht funktioniert

- **Kein Forget…-Button:** Prüfe Dateiname, Preview-Modus und ungespeicherte Änderungen. Der Button existiert nur in `memory_summary.md` hinter obersten `- `-Einträgen.
- **Apply Forget plan bleibt deaktiviert:** Bestätige bei mehreren oder ähnlichen Treffern mindestens eine passende Durable Source und klicke **Update plan**.
- **Stale- oder Hash-Fehler:** Eine Quelldatei hat sich seit der Vorschau verändert. Schließe den Dialog, lade die Memory-Analyse neu und beginne erneut.
- **Recheck meldet resurfaced:** Öffne die genannten Dateien und prüfe, ob der gefundene Abschnitt wirklich dieselbe Information ausdrückt. Der regelbasierte Ähnlichkeitsabgleich kann bewusst vorsichtig anschlagen.

## Aktuelle Grenzen

- Ein angewendeter Vorgang bearbeitet genau einen Summary-Eintrag; Projektpläne sind Vorschauen.
- Die Einzel-Memory-Auswahl startet in `memory_summary.md`, die Projektvorschau über **Forget project…**.
- Die Quellzuordnung ist lokal und deterministisch, nicht frei semantisch.
- Es gibt noch keine Projekt-Anwendung und keinen automatischen Watcher.
- Eine spätere Neuerzeugung durch externe Memory-Prozesse kann nicht garantiert verhindert werden.
