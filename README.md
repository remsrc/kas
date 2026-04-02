# KIM Attachment Search

Das Addon soll die Suche innerhalb von KIM-Mails nach Metadaten vereinfachen.
Es richtet sich an Ärzte/Ärztinnen und andere Teilnehmer des deutschen Gesundheitswesens, die an die Telematik-Infrastruktur angebunden sind und die eArztbriefe versenden und empfangen.
## Ausgangslage
Die Besonderheit von __KIM-Mails__ mit eArztbriefen ist, dass die eigentliche Information (Patient, Arzt und Praxis, Befund) in einem PDF- oder DOCX-Anhang steht und die Meta-Daten (Dokumentdatum, Patient, Geburtsdatum, Geschlecht, Arzt und Arztpraxis) in einem XML-Dokument verborgen sind.
Sobald der eigene KIM-Account (POP3) in Thunderbird korrekt eingerichtet ist und Mails empfangen werden können, sieht die Nachrichtenliste meist sehr ernüchternd aus. Ausser "Betreff: Arztbrief" und im Nachrichteninhalt "eArztbrief" sieht man nicht, für welchen Patienten dieser Brief geschrieben wurde.
## Lösung
Dieses Addon macht folgende Dinge:
- Ein Suchfenster wird als Button bereitgestellt, mit dem man sehr komfortabel und schnell nach allen gewünschten Informationen suchen kann.
- beim Öffnen einer __KIM-Mail__ wird oben im Nachrichtenkopf eine Zeile mit den Metadaten eingeblendet.
## Technische Umsetzung
alle KIM-Accounts **<name>@<xxx>.kim.telematik** werden nach Anhängen (XML/PDF/DOCX) durchsucht, die Inhalte werden suchbar gemacht und in einer Thunderbird-eigenen Datenbank gespeichert. Gleichzeitig werden die Meta-Daten zu jeder __KIM-Mail__ erfasst.
## Suchfenster
Wird im Suchfenster ein Begriff eingegeben, werden alle indexierten __KIM-Mails__ nach dem Begriff durchsucht (Beim ersten Start kann dies allerdings noch länger dauern).
Die Ergebnisse werden in einer Tabelle dargestellt. Jede Spalte ist veränderbar:
- sie kann in der Breite verändert werden
- sie kann eine andere Postion bekommen (Drag&Drop)
- sie kann ein- und ausgeblendet werden (rechter Mausklick auf die Spaltenüberschriften)
- sie ist sortierbar (Klick auf die Spaltenüberschrift)
Die Spaltenpositionen und die Fenstergröße bleiben beim Schließen des Suchfensters erhalten
Es ist durch Klicken auf 🔄 möglich, den kompletten Index neu zu generieren (dies dauert je nach Anzahl der __KIM-Mails__ und __KIM-Accounts__ aber Zeit).
### Suche
Die Suche ist __google-like__:
- Suchbegriff: __Meier__: alle Dokumente, die __Meier__ enthalten, werden durchsucht und alle __KIM-Mails__ werden angezeigt
- Suchbegriff "__Dr. Meier__": exakt dieser Suchbegriff wird gesucht
- Suchbegriff __Dr.__ __+Meier__: Meier muss gefunden, __Dr.__ kann gefunden werden
- Suchbegriff __-Dr.__ __Meier__: __Dr.__ darf nicht gefunden werden, __Meier__ muss gefunden werden
- Suchbegriff __*__: alle __KIM-Mails__ werden ausgegeben
- Suchbegriff __Mei*__: alle Wörter, die mit __Mei__ beginnen, werden durchsucht
- Suchbegriff __*ier__: alle Wörter, die mit __ier__ enden, werden durchsucht
- Suchbegriff __Me?er__: Meier, Meier, Meter werden durchsucht
