---
title: Kalender über Microsoft-365-Tenants synchronisieren
description: Halte die Kalender zweier Firmen oder von Kunden-Tenants synchron, damit dich niemand in einem der Tenants doppelt bucht.
sidebar:
  order: 3
---

Du arbeitest in zwei Microsoft-365-Tenants, zum Beispiel als Gründerin oder Gründer zweier Firmen
oder in der Beratung mit einem Konto beim Kunden. Frei/Gebucht-Freigaben zwischen Tenants brauchen
einen Admin auf beiden Seiten und fehlen oft. Mit dieser Anleitung synchronisierst du die Kalender
selbst, als belegte Blöcke.

## Warum keine Frei/Gebucht-Freigabe zwischen den Tenants?

Microsoft 365 kann Frei/Gebucht-Informationen zwischen Tenants teilen. Ein Admin jedes Tenants muss
das einrichten. Der andere Tenant sieht dann deine Verfügbarkeit, aber deine eigenen Kalender
blocken sich weiterhin nicht gegenseitig.

slotmirror braucht in keinem Tenant eine Änderung, außer ein Tenant schränkt die Zustimmung durch
Benutzer ein. Es schreibt die Blöcke in deinen Kalender in jedem Tenant. Frei/Gebucht-Abfragen in
jedem Tenant sehen sie deshalb.

## Schritte

1. Lege eine [Microsoft-Entra-App](../../../docs/entra-setup/) mit dem Kontotyp **Accounts in any
   organizational directory and personal Microsoft accounts** an. Eine App für nur einen Tenant
   kann den zweiten Tenant nicht verbinden.
2. Richte slotmirror mit dem [Quickstart](../../../docs/quickstart/) ein und setze `PUBLIC_URL`.
3. Verbinde unter **Konten** ein Konto pro Tenant. Blockt ein Tenant die Zustimmung durch Benutzer,
   muss sein Admin der App einmal zustimmen.
4. Füge auf der Seite **Regeln** die Kalender zur Gruppe **Blocken sich gegenseitig** hinzu.
5. Wähle **Speichern**.

## Namen auf der Seite Regeln

slotmirror leitet aus jeder Adresse einen kurzen Namen ab. Du kannst ein Konto umbenennen, zum
Beispiel nach der Firma. Die Übersicht liest sich dann „von Firma A an Firma B“.

## Gut zu wissen

- Jeder Tenant sieht nur „Belegt“, als privat markiert, außer du wählst für eine Richtung mehr
  Details.
- Wenn du dich mit einem Tenant anmeldest und nur dessen Konten zulassen willst, siehe
  [Organisations](../../../docs/organisations/).

## Fragen

### Brauche ich Admin-Rechte in jedem Tenant?

Meistens nicht. Du verbindest in jedem Tenant dein eigenes Konto. Blockt ein Tenant die
Zustimmung durch Benutzer, muss sein Admin der App einmal zustimmen. Siehe
[Microsoft Entra app](../../../docs/entra-setup/).

### Kann ich mehr als zwei Tenants verbinden?

Ja. Verbinde ein Konto pro Tenant und füge ihre Kalender zur Gruppe **Blocken sich gegenseitig**
hinzu.

### Sieht ein Kunde die Termine eines anderen Kunden?

Nein, außer du wählst für diese Richtung mehr Details. Standardmäßig sieht jeder Tenant nur
„Belegt“, als privat markiert.

## Verwandte Anleitungen

- [Outlook und Google Kalender synchronisieren](../sync-outlook-and-google-calendar/)
- [Privaten Kalender bei der Arbeit als belegt zeigen](../show-private-calendar-as-busy-at-work/)
