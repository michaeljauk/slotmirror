---
title: Selbst gehosteter Kalender-Sync für Outlook und Google
description: Betreibe deinen eigenen Sync belegter Zeiten zwischen Microsoft-365- und Google-Kalendern, damit kein Sync-Dienst Zugriff auf deine Kalender hat.
sidebar:
  order: 5
---

Ein Kalender-Sync-Dienst braucht Zugriff auf jeden Kalender, den du verbindest. Er hält für jedes
Konto ein Token und kann deine Termine lesen. Mit slotmirror richtest du den Sync in deinem eigenen
Cloudflare-Konto ein. Zwischen deinen Kalendern und deiner Installation steht kein
slotmirror-Dienst.

## Was in deinem Konto bleibt

- **Die Tokens.** Jedes verbundene Konto hat ein OAuth-Token, verschlüsselt mit AES-256-GCM. Den
  Schlüssel setzt du als Secret.
- **Die Kontodaten.** Die E-Mail-Adresse jedes Benutzers, die Namen der Kalender und bei
  Microsoft-Konten die Tenant-ID und die Objekt-ID.
- **Die Regeln und das Aktivitätsprotokoll.** Das Protokoll enthält Zeiten, Zählwerte und
  Fehlercodes, keine Termininhalte. Einträge, die älter als 90 Tage sind, werden gelöscht.
- **Keine Termininhalte.** Titel, Beschreibungen, Orte und Teilnehmende werden während eines Syncs
  gelesen und nur im Speicher gehalten. Sie landen nicht in der Datenbank. Eine Ausnahme: Lassen
  sich Blöcke nicht entfernen, bleibt ihr Titel 90 Tage gespeichert, damit jemand sie von Hand
  löschen kann. Siehe [Delete data](../../../docs/privacy/#delete-data).

Du kannst die Daten in der EU halten. Siehe [Privacy and data location](../../../docs/privacy/).

## Was du brauchst

- Ein Cloudflare-Konto. slotmirror läuft heute im Workers-Free-Plan. Ein großes Team kann Workers
  Paid brauchen. Siehe [Limits](../../../docs/limits/).
- Deine eigene [Microsoft-Entra-App](../../../docs/entra-setup/) für Microsoft 365 und
  Outlook.com und deinen eigenen [Google-OAuth-Client](../../../docs/google-setup/) für den
  Google Kalender. Du brauchst nur die für die Kalender, die du verbindest.

Der [Quickstart](../../../docs/quickstart/) deckt die Installation, die Apps und die ersten
Regeln ab.

## Was du übernimmst

Selbst hosten verlagert Arbeit von einem Dienst zu dir:

- **Google zeigt eine Warnung.** Bis Google deinen OAuth-Client prüft, warnt es, dass die App nicht
  verifiziert ist. slotmirror zeigt vor der Weiterleitung einen Hinweis dazu. Bleibt der Client im
  Modus **Testing**, lässt Google die Refresh-Tokens nach 7 Tagen ablaufen. Siehe
  [Google OAuth client](../../../docs/google-setup/).
- **Secrets laufen ab.** Das Client-Secret der Entra-App hat ein Ablaufdatum. Läuft es ab, schlägt
  die Token-Erneuerung fehl und der Sync stoppt. Lege vor diesem Datum ein neues Secret an.
- **Updates sind deine Sache.** Du entscheidest, wann deine Installation auf eine neue Version
  wechselt. Siehe [Updating your deployment](../../../docs/updating/).
- **Es ist eine frühe Version.** Die Version liegt unter 1.0. Einstellungen und Datenbank können
  sich zwischen Releases noch ändern.

## Für andere betreiben

Richtest du slotmirror für ein Team ein, bist du der Betreiber. Die Tokens aller Mitglieder liegen
dann in deinem Cloudflare-Konto. Setze `OPERATOR_NOTICE` und schreibe hinein, wer die Installation
betreibt und was du sehen kannst. Mitglieder sehen diesen Hinweis, bevor sie ein Konto verbinden.
Siehe [Settings reference](../../../docs/settings/).

Um die Anmeldung auf deinen Tenant zu beschränken, brauchst du drei Einstellungen zusammen. Siehe
[Limit who signs in](../../../docs/organisations/#limit-who-signs-in). Ein Admin kann außerdem
begrenzen, wie viele Details zwischen Org-Konten und anderen Konten fließen. Siehe
[Org accounts and detail caps](../../../docs/organisations/#org-accounts-and-detail-caps).

## Verwandte Anleitungen

- [Outlook und Google Kalender synchronisieren](../sync-outlook-and-google-calendar/)
- [Privaten Kalender bei der Arbeit als belegt zeigen](../show-private-calendar-as-busy-at-work/)
