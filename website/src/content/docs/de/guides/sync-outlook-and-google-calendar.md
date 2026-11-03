---
title: Outlook und Google Kalender synchronisieren
description: Zeige deine Outlook-Termine im Google Kalender und deine Google-Termine in Outlook, als belegte Blöcke oder mit Titel, ohne Sync-Dienst.
sidebar:
  order: 1
---

Du hast einen Outlook-Kalender für die Arbeit und einen Google Kalender für alles andere. Wer dich
in einem Kalender bucht, sieht den anderen nicht. Mit dieser Anleitung zeigt jeder Kalender die
Termine des anderen.

## Warum ein Kalender-Abo nicht reicht

Outlook und Google Kalender können einen Kalender über seine Adresse abonnieren, einen ICS-Link. Du
siehst den anderen Kalender dann neben deinem. Ein Abo hat drei Grenzen:

- Es ist schreibgeschützt und geht nur in eine Richtung.
- Die Kalender-App aktualisiert es nach eigenem Zeitplan. Eine Änderung kann Stunden oder länger
  brauchen.
- Wer nachsieht, wann du frei bist, sieht deinen Hauptkalender. Die Termine eines abonnierten
  Kalenders erscheinen dort nicht.

slotmirror schreibt echte Termine in den Hauptkalender jedes Kontos. Wer nachsieht, wann du frei
bist, sieht dann die Blöcke. Mit `PUBLIC_URL` startet eine Änderung die Synchronisation, sobald der
Anbieter sie meldet. Ohne `PUBLIC_URL` kommt die Änderung beim nächsten Lauf an, nach höchstens
10 Minuten.

## Was du bekommst

- Arbeitstermine erscheinen im Google Kalender, auf Wunsch mit Titel.
- Google-Termine erscheinen in Outlook als „Belegt“, als privat markiert.
- Ein verschobener oder abgesagter Termin verschiebt oder entfernt seine Kopie.

## Schritte

1. Richte slotmirror mit dem [Quickstart](../../../docs/quickstart/) ein.
2. Lege eine [Microsoft-Entra-App](../../../docs/entra-setup/) und einen
   [Google-OAuth-Client](../../../docs/google-setup/) an.
3. Setze `PUBLIC_URL`, damit die Anbieter deine Installation über Änderungen informieren.
4. Melde dich an und verbinde beide Konten unter **Konten**.
5. Nutze auf der Seite **Regeln** den **Schnellstart**: Beide Kalender blocken sich dann
   gegenseitig als belegt.
6. Klappe die Karte des Outlook-Kontos auf. Wähle für das Google-Ziel **Mit Titel** oder **Alles**.
   Die Zeile **Dort:** zeigt das Ergebnis.
7. Wähle **Speichern**.

## Gut zu wissen

- Kopien landen im Hauptkalender jedes Kontos.
- Termine, die in der Quelle als privat markiert sind, tragen nie mehr als „Belegt“.
- Ganztägige Termine wie Feiertage werden standardmäßig gespiegelt und blocken den ganzen Tag.
  Termine, die als frei markiert sind, bleiben draußen. Um alle ganztägigen Termine auszulassen,
  schalte **Ganztägige Termine auslassen** unter **Für alle Kalender** ein.

## Fragen

### Funktioniert das mit Outlook.com und Gmail?

Ja. Auf der Microsoft-Seite verbindet slotmirror Geschäfts- und Schulkonten von Microsoft 365 und
persönliche Microsoft-Konten wie Outlook.com. Persönliche Konten brauchen in der
[Entra-App](../../../docs/entra-setup/) den Kontotyp **Accounts in any organizational directory and
personal Microsoft accounts**. Auf der Google-Seite verbindet es Google-Konten.

### Sieht der Google Kalender die Titel meiner Outlook-Termine?

Standardmäßig nicht. Auf der Stufe **Als belegt** trägt eine Kopie nur den Titel aus **Titel
belegter Blöcke**, standardmäßig „Belegt“. Titel, Ort und Teilnehmende des Termins bleiben draußen.
**Mit Titel** fügt den Titel hinzu, **Alles** weitere Details. Du wählst die Stufe für jede
Richtung, und die Zeile **Dort:** zeigt das Ergebnis.

### Was passiert mit einer Serie?

Jeder Termin einer Serie wird einzeln gespiegelt. Wird ein Termin verschoben, wandert seine Kopie
mit. Wird er abgesagt, verschwindet seine Kopie.

### Brauche ich einen Server?

Nein. slotmirror läuft heute in deinem eigenen Cloudflare-Konto, im Workers-Free-Plan. Ein großes
Team kann Workers Paid brauchen. Siehe [Limits](../../../docs/limits/).

## Verwandte Anleitungen

- [Privaten Kalender bei der Arbeit als belegt zeigen](../show-private-calendar-as-busy-at-work/)
- [Kalender über Microsoft-365-Tenants synchronisieren](../sync-multiple-microsoft-365-tenants/)
