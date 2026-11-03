---
title: Privaten Kalender bei der Arbeit als belegt zeigen
description: Blocke Zeit im Arbeitskalender für private Termine, ohne dass Kolleginnen und Kollegen sehen, worum es geht.
sidebar:
  order: 2
---

Kolleginnen und Kollegen buchen dich für ein Meeting, während du beim Zahnarzt bist. Sie sehen
deinen privaten Kalender nicht, also wissen sie es nicht. Diese Anleitung setzt für jeden privaten
Termin einen Block „Belegt“ in deinen Arbeitskalender, und sonst nichts.

## Warum es nicht reicht, den Kalender in Outlook hinzuzufügen

Du kannst einen privaten Kalender in Outlook hinzufügen, als Abo oder über eine Freigabe. Dann
siehst du deine privaten Termine neben der Arbeit. Wer nachsieht, wann du frei bist, sieht aber
weiterhin nur deinen Arbeitskalender. Blöcke, die du von Hand kopierst, veralten, sobald sich ein
Termin verschiebt.

slotmirror schreibt für jeden privaten Termin einen Block in deinen Arbeitskalender. Ändert sich
der Termin, verschiebt oder entfernt es den Block.

## Schritte

1. Richte slotmirror mit dem [Quickstart](../../../docs/quickstart/) ein und verbinde dein Arbeits-
   und dein privates Konto.
2. Füge auf der Seite **Regeln** beide Kalender zur Gruppe **Blocken sich gegenseitig** hinzu.
3. Klappe die Karte des privaten Kontos auf. Lass für den Arbeitskalender **Als belegt** stehen.
4. Lass unter **Für alle Kalender** die Option **Kopien als privat markieren** eingeschaltet.
   Kolleginnen und Kollegen sehen dann „Privat“. Du siehst weiterhin alles.
5. Wähle **Speichern**.

## Den Titel der Blöcke wählen

Die Blöcke tragen den Titel aus **Titel belegter Blöcke**, zum Beispiel „Belegt“ oder „Geblockt“.
Titel, Ort und Teilnehmende des privaten Termins gelangen nicht in den Arbeitskalender.

## Für ein Team

Ein Admin kann das für alle festlegen: `MAX_DETAIL_FROM_EXTERNAL=busy` begrenzt jede Richtung von
einem privaten Konto zu einem Arbeitskonto auf „Belegt“. Siehe
[Organisations](../../../docs/organisations/).

## Fragen

### Sehen Kolleginnen und Kollegen, worum es bei dem Termin geht?

Nein. Ein Block trägt den Titel aus **Titel belegter Blöcke**, standardmäßig „Belegt“. **Kopien als
privat markieren** ist standardmäßig eingeschaltet. Wer deinen Kalender öffnen darf, sieht deshalb
„Privat“. Wer nur nachsieht, wann du frei bist, sieht, dass du belegt bist. Titel, Ort und
Teilnehmende des Termins bleiben in deinem privaten Kalender.

### Wer hat Zugriff auf meinen privaten Kalender?

Wer die Installation betreibt. Richtest du slotmirror selbst ein, liegen die Tokens in deinem
eigenen Cloudflare-Konto. Betreibt dein Arbeitgeber die Installation, liegen sie in dessen Konto.
Die Seite `/privacy` der Installation zeigt den Kontakt des Betreibers, wenn er einen eingetragen
hat. Siehe [Privacy and data location](../../../docs/privacy/).

### Was ist mit Feiertagen und freien Tagen?

Ganztägige Termine blocken standardmäßig den ganzen Tag. Termine, die als frei markiert sind,
bleiben draußen. Um alle ganztägigen Termine auszulassen, schalte **Ganztägige Termine auslassen**
unter **Für alle Kalender** ein.

## Verwandte Anleitungen

- [Outlook und Google Kalender synchronisieren](../sync-outlook-and-google-calendar/)
- [Zeit für einen Team- oder Vereinskalender blocken](../block-team-or-club-calendar/)
