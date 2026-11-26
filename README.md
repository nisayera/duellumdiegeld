# Schätzpoker 🎲❓

Moderator-Webseite für einen Schätzpoker-Abend – Quiz trifft Poker, inspiriert von „Das Duell um die Geld“.

**Spielen:** https://nisayera.github.io/duellumdiegeld/

## Ablauf einer Runde
1. **Blinds** – Dealer-Button wandert weiter, Small & Big Blind werden angesagt (steigen automatisch).
2. **Frage** – alle schreiben ihre Schätzung verdeckt auf (optional mit Timer).
3. **Setzrunde 1** → **Hinweis 1** → **Setzrunde 2** → **Hinweis 2** → **Setzrunde 3**
4. **Showdown** – Schätzungen aufdecken, Lösung wird gezeigt. Wer am nächsten dran ist, gewinnt den Pot.

## Zwei Modi
- **Nur Moderator** – ihr spielt mit echten Chips, die Seite sagt Blinds, Fragen und Hinweise an.
- **Mit digitalen Chips** – die Seite verwaltet zusätzlich Stacks, Einsätze und Pot (No-Limit, inkl. Side-Pots bei All-in).

## Am eigenen Handy spielen
Auf der Hauptseite unter 📱 erscheint ein QR-Code. Jeder Spieler scannt ihn, tippt seinen Namen an und kann dann:
- seine Schätzung **geheim** am Handy eingeben (wird beim Showdown automatisch eingetragen)
- im Chip-Modus selbst passen, mitgehen, erhöhen oder All-in gehen – das Handy vibriert, wenn man dran ist

Die Verbindung läuft per WebRTC direkt zwischen den Geräten (Vermittlung über den kostenlosen PeerJS-Server), ein eigener Server ist nicht nötig. Alle Geräte brauchen Internet.

## Features
- 167 eingebaute Schätzfragen mit je 2 Hinweisen – überwiegend mit großen Zahlenbereichen (Höhen, Längen, Jahreszahlen, Rekorde, Kombinatorik)
- Ausführliche Regeln: Poker-Basics, Spielzüge, Side-Pots, Spielen ohne Croupier, Chips aufteilen
- Anfänger-Hilfe: kurze Erklärung bei jedem Schritt
- Pot-Rechner im Moderator-Modus für All-ins und Side-Pots
- Chip-Aufteilung für dein eigenes Set (bis zu 5 Farben mit Wert und Anzahl)
- Eigene Fragen hinzufügen, exportieren & importieren (werden im Browser gespeichert)
- Sprachausgabe als Moderator – Stimme & Tempo wählbar, beste Stimme wird automatisch gewählt (Tipp: Microsoft Edge oder Premium-Stimmen am Mac)
- Rückgängig-Funktion, Spielstand bleibt beim Neuladen erhalten
- Bedienung per Leertaste – ideal für Fernseher/Beamer

## Lokal starten
Einfach `index.html` im Browser öffnen – keine Installation nötig.

Fragen ergänzen: in `questions.js` oder direkt auf der Seite unter „Fragen verwalten“.
