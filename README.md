# KIM Attachment Search
Das Addon vereinfacht die Suche innerhalb von **KIM-Mails** nach Metadaten und beliebigen Begriffen. Vor allem __Patienteninformationen, Arzt und Praxis__ des **eArztbriefes** werden nun direkt in der Mail angezeigt.
Es richtet sich an Ärzte/Ärztinnen und andere Teilnehmer des deutschen Gesundheitswesens, die an die Telematik-Infrastruktur angebunden sind und die **eArztbriefe** versenden und empfangen.
Voraussetzung ist ein eingerichteter und funktionionierender POP3 <kim.telematik>-Account.
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

# Reviewer Documentation – KIM Attachment Search (Thunderbird Add-on)

## 1. Purpose of the Add-on

KIM Attachment Search improves usability of emails received via the German KIM (Kommunikation im Medizinwesen) system.

KIM emails containing eArztbrief (electronic medical letters) typically include:

* human-readable content in PDF/DOCX attachments
* structured metadata in an XML attachment

Standard Thunderbird views do not expose this metadata.
This add-on extracts and indexes relevant information to make it searchable and visible.

---

## 2. Key Features

### 2.1 Metadata Display

When opening a KIM email, the add-on:

* parses XML attachments
* extracts metadata (e.g. patient, physician, practice, document date)
* displays this information in an additional header line in the message view

---

### 2.2 Full-Text and Metadata Search

The add-on provides a dedicated search window:

* searches across indexed KIM emails
* includes:

  * attachment contents (XML, PDF, DOCX where applicable)
  * extracted metadata
* results are displayed in a sortable and configurable table

#### Supported query syntax (Google-like)

* `Meier` → full-text match
* `"Dr. Meier"` → exact phrase
* `Dr. +Meier` → Meier required, Dr optional
* `-Dr. Meier` → Meier required, Dr excluded
* `*` → all indexed messages
* `Mei*`, `*ier`, `Me?er` → wildcard searches

---

## 3. Technical Scope

* The add-on operates on POP3 accounts with domain `*.kim.telematik`
* It scans messages for attachments:

  * XML (primary metadata source)
  * PDF / DOCX (content indexing where possible)
* Extracted data is stored in a local Thunderbird database (indexed storage)
* No external data transmission occurs

---

## 4. Important Note for Reviewers (Test Environment)

### 4.1 No Public KIM Test Accounts

KIM is part of the German Telematics Infrastructure (TI) and requires:

* certified identities (SMC-B / eHBA)
* access to a KIM provider

Therefore:

* no public or shared test accounts exist
* Thunderbird reviewers cannot access real KIM environments

---

## 5. How to Test Without KIM Infrastructure

The add-on is designed to be testable using standard Thunderbird functionality.

### Step-by-step testing procedure

1. Set the following constants in `background.js`:

   * `ADDONTEST = true`
   * optionally `DEBUG = true`

2. Import sample emails (`.eml`) into Thunderbird
   (drag & drop into a folder)

   * `mail_x.eml` → simple test mails
   * `kim_earztbrief_xx.eml` → TI-compatible (HL7 XML structure)

3. Ensure the email contains:

   * an XML attachment (metadata)
   * optionally PDF/DOCX attachments

4. Open the message
   → The add-on should display an additional metadata header line

5. Open the search window via the add-on button

6. Perform searches:

   * simple term (e.g. `Meier`)
   * wildcard (`Mei*`)
   * phrase (`"Dr. Meier"`)

7. Verify:

   * results appear in the table
   * sorting and column configuration work

---

## 6. Expected Behavior

* Add-on activates only for relevant messages (based on structure/domain)
* No errors or UI disruptions in standard Thunderbird workflows
* Indexing may take time on first run (depending on mailbox size)

---

## 7. Privacy and Security

* All processing is local
* No network communication beyond standard mail access
* No external APIs or data exfiltration

---

## 8. Limitations

* Full functionality depends on presence of structured XML attachments
* Real KIM-specific transport/security layers are not required for testing
* Content extraction quality depends on attachment format

---

## 9. Use of PDF.js

This add-on includes the official Mozilla PDF.js library (`pdfjs-dist`) for extracting text content from PDF attachments.

During validation, warnings may appear regarding:

* use of the `Function` constructor (eval-like behavior)
* dynamic `import()` usage

These originate from the upstream PDF.js implementation.

Important clarifications:

* The library is included unmodified from the official distribution
* No dynamic code execution is implemented by this add-on
* No remote scripts or external code are loaded
* All processing happens locally within Thunderbird

Version used:

```
pdfjs-dist v5.6.205
```

---

## 10. Summary for Review

This add-on:

* enhances message readability and searchability
* operates entirely within Thunderbird
* can be tested deterministically using sample `.eml` files
* does not require access to the Telematics Infrastructure

---

If required, additional test files or clarification can be provided.

