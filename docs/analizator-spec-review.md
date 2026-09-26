# Stan wdrożenia specyfikacji analizatora

Aktualizacja: 2026-09-26.

## Wdrożone

- Stockfish 19: screening głównej linii, MultiPV 3 z tej samej ukończonej głębokości, WDL, ograniczone refinements, decisionWeight i significance.
- Książka repertuarowa: transpozycje, kolorowanie przed analizą, pomijanie ruchów książkowych przez silniki.
- Maia 3: wybór ważnych pozycji po screeningu, sentinele ratingowe, warunkowa kotwica i refinement, limity czasu i zapytań.
- Granice masy dobrych ruchów, dostępność odpowiedzi, entropy i przeoczenie odpowiedzi na błąd przeciwnika. Trudność odpowiedzi nie usuwa błędu obiektywnego.
- Ochrona bezpiecznego upraszczania; filtrowanie wymuszonych ruchów i oczywistych odbić przy wyróżnieniach.
- Ratingi z PGN i ręczne ustawienia obu graczy, system ratingowy i tempo. Surowy rating poza zakresem Maia pozostaje zachowany. Performance wymaga odpowiedniej liczby informacyjnych decyzji.
- Raport przewagi, faz, jakości decyzji, ważnych momentów i statystyk Maia; komentarze i klikalne warianty, nawigacja bez kasowania zapisu.
- Opening Explorer i Syzygy: ograniczenia czasu, cache, anulowanie i obsługa 429. Explorer używa istniejącego tokenu użytkownika, jeśli jest ustawiony. Awaria bazy nie zatrzymuje analizy.
- Postęp na planszy i w zapisie, szybka i szczegółowa analiza, zamykany raport i interfejs mobilny.

## Weryfikacja

- `npm run verify:analysis`: regresje WDL, ratingów, performance, limitów Maia, pomijania książki i anulowania. Pipeline sprawdzany kontrolowanymi odpowiedziami modeli i sieci.
- `npm run build -- --configLoader runner`: TypeScript i build produkcyjny.
- Przeglądarka z prawdziwymi silnikami: import PGN i szczegółowa analiza 16 półruchów, raport, nawigacja bez usuwania zapisu, szerokość 390 px i zachowanie surowego ratingu 900.

## Ograniczenia

- Performance Elo i przedziały są heurystyczne; brak kalibracji na korpusie partii i konwersji między FIDE i platformami.
- Fazy, motywy i oczywistość są heurystyczne; brak pełnego dowodzenia poświęceń i kompletnego klasyfikatora motywów taktycznych.
- MultiPV obejmuje ograniczoną liczbę ruchów. Nieznana masa policy pozostaje przedziałem.
- Brak długoterminowej karty stylu gracza z wielu partii. Ćwiczenia odłożono zgodnie z decyzją użytkownika.
- Bazy zewnętrzne mogą nie zwrócić danych; raport nie wymyśla wtedy częstości ani wyników tablebase.
