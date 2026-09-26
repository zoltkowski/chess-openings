# Specyfikacja analizy partii — zadanie dla modelu Sol

Status: uzgodniony projekt funkcjonalny do implementacji. Data: 2026-09-24.
Dokument nie oznacza, że opisane funkcje są już zaimplementowane.

## 1. Cel i zasady nadrzędne

Zaimplementuj recenzję całej partii łączącą Stockfisha (jakość ruchów)
z Maią (przewidywane ludzkie decyzje zależne od ratingu). Recenzja ma
identyfikować dobre i słabe decyzje, wyjaśniać je oraz tworzyć ćwiczenia.

Wymagania użytkownika mają pierwszeństwo przed heurystykami:

1. Nie przyznawaj szczególnych pochwał za oczywiste ruchy, w szczególności
   automatyczne odbicia. Najlepszy ruch nie musi być trudnym znaleziskiem.
2. Nie oznaczaj bezpiecznego uproszczenia wygranej pozycji jako błędu tylko
   dlatego, że ocena spadła np. z +10 do +7.
3. Analiza ma działać na desktopie i telefonie, bez blokowania interfejsu.
4. Włączenie Analysis mode zachowuje aktualną pozycję i orientację planszy.
5. Nawigacja po partii nie usuwa dalszych ruchów ani wariantów.
6. Analizuj całą wybraną linię partii, również jej część za kursorem.
7. Oddziel ocenę jakości, trudność decyzji i dodatkowe wyróżnienia.
8. Przy braku dowodów stosuj neutralny opis; nie wymyślaj uzasadnień.

## 2. Zakres i kolejność implementacji

- Etap A: trwały raport, kolejka silników, klasyfikacja jakości, wykres,
  pełna linia partii, obsługa stanów końcowych i niepewności.
- Etap B: Maia, trudność, naturalne błędy, ostrożne wyróżnienia,
  rozpoznawanie bezpiecznych uproszczeń.
- Etap C: 3–5 momentów do nauki, ćwiczenia i podsumowania z dowodami.
- Etap D: profil z wielu partii i skalibrowany estymator poziomu gry.

Nie przedstawiaj niezaimplementowanych etapów jako działających.
Estymacja Elo pozostaje eksperymentalna i ukryta do czasu walidacji.
Nie uruchamiaj innego modelu ani osobnego zadania na podstawie tego dokumentu;
jest to instrukcja dla modelu, któremu użytkownik zleci implementację.

## 3. Dane wejściowe i wybór partii

- Wejście: początkowy FEN, uporządkowane ruchy UCI, identyfikatory węzłów,
  opcjonalne nagłówki PGN, ratingi obu graczy, platforma i tempo gry.
- Ratingi i tempo pobieraj z PGN, pozwól je poprawić. Zapisuj ich źródło.
- Brak ratingu: pozwól wybrać poziom; do czasu wyboru pokazuj ocenę jakości,
  a spersonalizowane wyniki oznacz jako niedostępne lub oparte na jawnym
  poziomie referencyjnym. Nie wymyślaj ratingu użytkownika.
- Ratingi Lichess, Chess.com i FIDE nie są zamienne. Bez kalibracji nie
  przeliczaj ich automatycznie; pokazuj skalę poziomu używanego przez Maię.
- Przy rozgałęzieniach użyj jawnie wskazanej głównej kontynuacji. Jeśli
  drzewo nie ma takiego oznaczenia, udostępnij wybór analizowanej linii.
  Nie wybieraj arbitralnie pierwszego dziecka.
- Uruchomienie analizy utrwala migawkę linii. Edycja partii unieważnia tylko
  zależne wyniki; rezultat starego zadania nie nadpisuje nowego drzewa.
- Do silnika przekazuj historię ruchów, aby uwzględnić powtórzenia i regułę
  50 posunięć. Sam FEN nie wystarcza do odtworzenia wszystkich powtórzeń.

## 4. Kontrakt silników i wiarygodność

Stockfish jest źródłem oceny jakości. Maia dostarcza rozkład prawdopodobieństw
legalnych ruchów dla ratingu strony na ruchu i przeciwnika. Wybrana zakładka
silnika w UI nie zmienia tych ról podczas recenzji.

Przed budową heurystyk sprawdź integrację:

- zgodność tokenizacji Mai z konkretnym eksportem ONNX (kolejność pól,
  figur, odbicie pozycji czarnych, indeksy promocji, roszada i en passant);
- interpretację wyjścia value: W + 0.5 D to oczekiwany wynik, nie samo P(win);
- perspektywę ocen Stockfisha, jednostki cp, mate oraz informacje bound;
- zgodność plików modelu, słownika ruchów, runtime i wersji silników;
- błędy silnika i timeouty nie mogą zwracać fikcyjnego +0.00;
- niegotowy model lub brak wyniku daje status unavailable, nie wynik zerowy.

Sprawdzenie kontraktu ma obejmować porównanie przykładowych pozycji z
referencyjną implementacją używanego eksportu. Nie zakładaj poprawności
obecnego adaptera wyłącznie dlatego, że model się ładuje.

Oceny przechowuj jako dane liczbowe/strukturalne, nie tylko tekst +0.50.
Zapisuj wersję silnika/modelu, konfigurację, depth, nodes, czas, PV i status.

## 5. Podstawowa klasyfikacja jakości

Wersja początkowa używa jawnego wskaźnika S opartego na formule Lichess:

    S(cp) = 100 / (1 + exp(-0.00368208 * cp))

To wskaźnik porównawczy, nie skalibrowana szansa wygranej użytkownika.
Nie mieszaj tej skali ze Stockfish WDL ani value Mai w jednym obliczeniu.

Dla pozycji przed ruchem porównaj najlepszy ruch i rzeczywiście zagrany
ruch, ocenione z perspektywy wykonującego ruch gracza:

    loss = max(0, S(bestCp) - S(playedCp))

Nie odejmuj surowych ocen o przeciwnych perspektywach. Zagrany ruch oceniaj
także wtedy, gdy nie mieści się w głównych liniach MultiPV (np. searchmoves).
Stosuj porównywalne budżety i pogłębiaj sprzeczne wyniki. Wyraźnie lepsza
ocena ruchu zagranego niż rzekomo najlepszego oznacza potrzebę ponownej
analizy, a nie nadzwyczajną zasługę gracza.

Progi v1 (konfigurowalne, nie twierdzenie o uniwersalnym standardzie):

| Kategoria | Reguła |
| --- | --- |
| best | stabilny najlepszy ruch lub potwierdzony równorzędny |
| excellent | loss < 2, jeśli nie best |
| good | 2 <= loss < 5 |
| inaccuracy / ?! | 5 <= loss < 10 |
| mistake / ? | 10 <= loss < 20 |
| blunder / ?? | loss >= 20 |

W UI excellent tłumacz neutralnie jako „Bardzo dobry”, a nie „Świetne
znalezisko”. best nie otrzymuje wykrzyknika ani animacji pochwały.

Równorzędność: początkowo strata <= 0.5 pp oraz stabilność po pogłębieniu.
To tolerancja numeryczna; nie oznacza matematycznie udowodnionej równości.
Jeśli loss jest w odległości <= 1 pp od granicy kategorii, pogłęb analizę.
Jeśli kategoria nadal zmienia się między przebiegami, pokaż ocenę wstępną
i nie przyznawaj wyróżnień. Zapisuj przyczynę obniżonej pewności.

Mat, pat, wymuszone remisy, tablebase i końcowe wyniki mają osobne typy.
Nie zamieniaj mate na arbitralną liczbę centypionów. Przeoczenie krótszego
mata przy zachowaniu potwierdzonej wygranej nie jest automatycznym błędem.
Utrata wymuszonej wygranej do remisu lub dopuszczenie wymuszonej porażki
wymaga osobnego zdarzenia i weryfikacji, niezależnie od nasycenia S.

## 6. Trudność decyzji i Maia

Pobieraj pełny rozkład legalnych ruchów, znormalizowany przed ograniczeniem
wyświetlanej listy. Nie normalizuj ponownie wyłącznie top K.

Dobry ruch do obliczenia trudności: loss < 2 pp, bez potwierdzonej utraty
wyniku i bez nierozstrzygniętej niestabilności analizy.

    goodMass = suma P_Maia(m) dla wszystkich dobrych ruchów

Początkowe przedziały: goodMass >= 0.70 łatwa decyzja; <= 0.15 trudna;
pomiędzy nimi umiarkowana. Wszystkie progi mają być wspólną konfiguracją.
Małe P zagranego ruchu nie dowodzi trudności, jeśli goodMass jest duże.

Jeśli Stockfish nie ocenił wszystkich ruchów, przechowuj masę nieocenioną U:

    goodMassLower = znana masa dobrych ruchów
    goodMassUpper = goodMassLower + U

Wyróżnienie wymagające trudności jest dozwolone tylko, jeśli także górna
granica spełnia próg. Rozszerzaj listę ocenianych kandydatów według masy Mai;
nie traktuj nieocenionych ruchów jako złych. „Jedyny dobry ruch” wymaga
weryfikacji wszystkich alternatyw, nie tylko top 3 MultiPV.

Po błędzie policz analogicznie masę odpowiedzi skutecznie wykorzystujących
błąd, dla ratingu przeciwnika. Próg skuteczności: odpowiedź zachowuje korzyść
i traci < 2 pp względem najlepszej odpowiedzi; niepewne odpowiedzi dają
przedział. Oddziel dotkliwość błędu od trudności jego wykorzystania.
Wartości procentowe podpisuj „szacunek Mai”, nie „tyle procent ludzi”.

Opcjonalne porównanie poziomu R i R+200 służy doborowi osiągalnych ćwiczeń.
Przytnij zakres do wspieranego przez konkretny model; nie ekstrapoluj.

## 7. Wyróżnienia i filtr oczywistości

Wyróżnienia są osobnymi tagami z dowodami i pewnością. Jedna podstawowa
kategoria pozostaje zawsze widoczna. Lista ruchów pokazuje najwyżej jedno
najważniejsze wyróżnienie, pozostałe w szczegółach.

### Obowiązkowy filtr

- Jeden legalny ruch: tag forced, brak !, !! i „świetnego znaleziska”.
- Automatyczne odbicie, zwykła wymiana lub zabranie darmowego materiału:
  domyślnie brak specjalnej pochwały.
- Duża różnica best–second nie omija filtra oczywistości.
- goodMass >= 0.70 blokuje wyróżnienie za trudność.
- Sama rzadkość, ruch silnika lub wzrost oceny między przebiegami nigdy
  nie wystarcza do wyróżnienia.
- Brak konkretnego uzasadnienia wyjątkowości oznacza rezygnację z pochwały.

Wykrywanie oczywistego odbicia: sprawdź poprzednie bicie, pole bicia,
przywrócenie bilansu materiału i krótką sekwencję wymiany. Samo bicie na
polu ostatniego ruchu nie jest dowodem oczywistości. Użyj tego jako filtra
ostrożności. Wyjątek wymaga potwierdzonego motywu: wybór nietypowej figury
do odbicia, ruch pośredni, ukryta kombinacja albo inna konkretna trudność,
oraz spełnienia warunków trudności Mai. Niskie P Mai samo nie znosi filtra.

### Reguły tagów v1

- greatFind / !: loss < 2, goodMassUpper <= 0.15, stabilna analiza,
  brak oczywistości i co najmniej jedna wiarygodna kusząca słabsza alternatywa.
- onlyDefense: jedyny ruch zachowujący wynik; wszystkie inne potwierdzone
  jako wyraźnie słabsze (początkowo strata >= 10 pp lub gorszy wymuszony
  wynik). Sam tag nie implikuje !. Oczywisty ruch pozostaje neutralny.
- brilliant / !!: spełnia greatFind, zawiera rzeczywistą ofiarę z
  potwierdzoną rekompensatą i pozostawia co najmniej równą pozycję.
  Nie przyznawaj za rutynową wymianę, chwilowe oddanie z automatycznym
  odbiciem ani efektowny dodatek w już łatwo wygranej pozycji.
  Sama zmiana bilansu materiału nie dowodzi ofiary; sprawdź legalne
  przyjęcie, odpowiedzi i kontynuację. Przy niepewności pomiń !!.
- interesting: loss < 2, małe P ruchu (startowo < 0.10), potwierdzony
  konkretny pomysł lub trudna odpowiedź przeciwnika. Rzadkość nie wystarcza.
- naturalMistake: loss >= 5 i P zagranego ruchu >= 0.20. To kontekst,
  który nie zmienia oceny jakości ani nie usprawiedliwia błędu.
- missedOpportunity: niewykorzystana konkretna korzyść; zapisz wariant
  pokazujący jej uzyskanie. Jeśli okazja powstała po błędzie przeciwnika,
  połącz oba zdarzenia. Nie naliczaj ich jako dwóch niezależnych strat.
- book: tylko potwierdzenie w zidentyfikowanej bazie debiutowej. Maia nie
  jest bazą debiutową. Tag nie nadpisuje złej oceny ruchu.
- practicalChoice / goodSimplification: według następnej sekcji.

Nie publikuj !!, jeśli nie ma wystarczającej implementacji detektora ofiar.
Lepiej pominąć wyróżnienie niż wygenerować fałszywą pochwałę.

## 8. Wygrane pozycje i uproszczenia

Spadek cp sam nie uruchamia ?!/?/??. W szczególności stabilne +10 -> +7
z zachowaniem wygranej nie dostaje znaku błędu. Obowiązuje również po
odwróceniu kolorów. Zachowaj surową ocenę w szczegółach.

Nasycenie wskaźnika S nie dowodzi łatwej wygranej. Rozróżniaj:

1. Zachowaną przewagę: Stockfish stabilnie potwierdza wygraną po ruchu.
2. Łatwiejszą realizację: są dodatkowe dowody zmniejszenia trudności.

Bezpieczne uproszczenie: brak utraty wyniku, brak nowych wymuszonych
zagrożeń i stabilna ocena. Próg cp może wybierać kandydatów (np. >= +5
przed i po), ale sam nie wystarcza do tagu. Gdy tablebase jest dostępne,
uwzględnij jego wynik wraz z regułą 50 posunięć.

Tag goodSimplification wymaga także co najmniej jednego potwierdzonego
dowodu ułatwienia: usunięcie konkretnego ataku, likwidacja kontrgry,
przejście do zweryfikowanej łatwej końcówki lub zwiększenie masy bezpiecznych
decyzji w kolejnych reprezentatywnych pozycjach. Mniejsza liczba figur sama
nie jest dowodem. Porównuj z najlepszą linią i realistycznymi odpowiedziami
Mai; nie wyciągaj wniosku o łatwości z jednej wybranej dogodnej odpowiedzi.

Nie ukrywaj: utraty wygranej do remisu, pata, fortecy, wiecznego szacha,
nowej wymuszonej porażki. Jeśli nie potrafisz potwierdzić uproszczenia,
pokaż neutralny dobry ruch bez tego tagu. Nie obiecuj wykrywania wszystkich
fortec bez tablebase; zapisuj ograniczoną pewność.

Pominięty szybszy mat przy zachowanej bezpiecznej wygranej: opcjonalna
ciekawostka, bez znaku błędu. Wygranie materiału zamiast mata również nie
jest automatycznie błędem. Gdy dalsza wygrana staje się trudniejsza, można
opisać ryzyko praktyczne bez sztucznego zwiększania straty jakości.

## 9. Dokładność i podsumowania

- Pokazuj dokładność 0–100 obu stron z jawną wersją metryki.
- Dla trybu zgodnego z Lichess użyj jego pełnego algorytmu (dokładność
  ruchów, okna zmienności i średnia harmoniczna), a nie samej średniej
  arytmetycznej. Przy adaptacji nazwij wynik własną metryką i opisz różnice.
- Nie zamieniaj dokładności w Elo i nie interpretuj jej jako wykrywania
  oszustw. Oddziel metrykę od tagów trudności i praktycznych decyzji.
- Podsumowanie: najwyżej 2 mocne strony, 2 obszary do pracy i 1 zalecenie.
- Każde stwierdzenie prowadzi do konkretnych ruchów i wariantów.
- Licz wykorzystane okazje / dostępne okazje. Brak błędów obronnych bez
  okazji do obrony nie dowodzi mocnej obrony.
- Rozpoznawaj najpierw motywy możliwe do sprawdzenia: widełki, związanie,
  ruch pośredni, pozostawiona figura, mat, promocja, przeoczona groźba.
- Wnioski strategiczne wymagają osobnych dowodów. Jedna partia nie
  uzasadnia diagnozy trwałego stylu lub słabości gracza.
- Komentarze v1 generuj z szablonów i dowodów. Opcjonalny LLM później
  redaguje wyłącznie sprawdzone fakty, nie jest źródłem wariantów.

## 10. Ćwiczenia i angażująca recenzja

Wybierz 3–5 momentów, a jeśli jest mniej wartościowych — mniej. Uwzględnij
błąd, okazję i dobre znalezisko, o ile wystąpiły. Usuń duplikaty wynikające
z jednej kombinacji. Priorytet: istotność, pewność, zrozumiały motyw,
trudność osiągalna dla gracza i różnorodność; nie tylko największa strata.

Przebieg:

1. Pozycja i konkretne pytanie, bez oceny, strzałek i etykiet zdradzających
   rozwiązanie (również w widocznej liście ruchów).
2. Użytkownik gra odpowiedź. Przyjmij każdy potwierdzony dobry ruch,
   nie tylko pierwszą linię Stockfisha. Nową odpowiedź sprawdź na żądanie.
3. Błędną próbę można rozegrać, aby zobaczyć konsekwencje.
4. Podpowiedzi: motyw -> figura/pole -> pierwszy ruch -> krótki wariant.
5. Wyjaśnienie, jedna zasada do zapamiętania, zapis do powtórek.

Rodzaje: znajdź lepszy ruch, ukarz własny błąd stroną przeciwnika,
udowodnij dalszy ciąg dobrego ruchu, znajdź bezpieczne uproszczenie.
Przycisk rozegrania pozycji z Maią używa wybranego poziomu.
Próby ćwiczeń nie zmieniają oryginalnej partii; osobne drzewo robocze.

## 11. Szacowanie poziomu gry obu stron

Funkcja etapu D. Nazwa: „Szacowany poziom gry w tej partii”, ze skalą,
przedziałem i pewnością. Nie przedstawiaj jako rzeczywistego Elo.

Kandydat do estymatora: suma log P_Maia(zagrany ruch | pozycja, R, Ropp)
dla siatki R, uzupełniona o straty Stockfisha i trudność decyzji. Pomijaj
ruchy wymuszone, ogranicz wpływ teorii i długich rozstrzygniętych końcówek.
Maia likelihood samo mierzy także styl; nie wystarcza do estymacji ratingu.

Kalibracja obowiązkowa na zbiorze partii ze znanymi ratingami i tempem.
Rozdziel trening/walidację według graczy, kontroluj wpływ przeciwnika,
sprawdź błąd i pokrycie przedziałów osobno dla przedziałów ratingowych.
Nie używaj wyniku partii ani podanego ratingu do ukrytego sztucznego
podciągania oceny. Każdy prior i jego wpływ muszą być jawne.
Przy małej liczbie informacyjnych decyzji lub wyjściu poza domenę modelu:
„Za mało danych”. Nie fabrykuj przedziałów przed ich kalibracją.

## 12. Architektura i wydajność

- Wydziel moduły: engine adapter/scheduler, analysis pipeline,
  classification, human difficulty, motif detection, review selection,
  report storage i UI. Nie rozbudowuj całej logiki w App.tsx.
- Jeden właściciel kolejki poleceń UCI. Analiza interaktywna i partii nie
  mogą mieszać wyników. jobId/requestId, anulowanie i ignorowanie starych
  odpowiedzi są obowiązkowe.
- Przebieg szybki -> pogłębienie kluczowych pozycji -> Maia -> raport.
  Nie ustalaj wspólnego limitu jednej sekundy jako dowodu wiarygodności.
  Budżety zależą od urządzenia; zapisuj osiągnięte parametry.
- Silniki poza głównym wątkiem, postęp, stop/wznów, częściowe wyniki,
  rozsądne limity pamięci i obsługa uśpienia karty na telefonie.
- Maia79M wymaga pomiaru wydajności. Rozważ zgodny mniejszy model do
  szybkiego trybu; zapisz wariant w raporcie, nie podmieniaj go po cichu.
- Cache obejmuje historię/relevant draw state, wersję silnika i ustawienia;
  dla Mai dodatkowo oba poziomy. Sam FEN nie wystarcza dla każdego wyniku.
- Raport utrwalaj osobno od pól stockfishEval drzewa (np. IndexedDB).
  Minimalne dane: schemaVersion, gameSnapshotHash, engine/model versions,
  settings, status, per-move candidates, raw scores, loss, probabilities,
  coverage bounds, category, tags/evidence, confidence, review moments.
- Zapewnij migrację lub bezpieczne unieważnienie starego raportu.

## 13. Interfejs

- Analysis mode w hamburgerze, ukryte Train i find missing popular
  opponent move oraz przyciski trybów treningowych.
- Analyze game zastępuje Train. Na telefonie ten sam rozmiar i styl
  przycisku co pozostałe, inna ikona, dostępna nazwa; podczas pracy Stop.
- Desktop: panel obok planszy. Telefon: karta pod planszą, jedno ćwiczenie
  naraz, bez szerokich tabel i poziomego przewijania.
- Nie zmieniaj pozycji przy uruchomieniu analizy. Dopiero wybór momentu
  recenzji nawiguje po planszy.
- Kategorie rozpoznawalne przez tekst/symbol, nie tylko kolor.
- Rozdziel stan wstępny, zakończony, częściowy, anulowany i błąd.
- Szczegóły techniczne dostępne na żądanie; główny ekran pokazuje wnioski.

## 14. Kryteria akceptacji i przypadki regresji

Sprawdź zachowanie na konkretnych legalnych pozycjach, z deterministycznymi
fixture danych silników dla progów i oddzielną weryfikacją integracji:

1. Jedyny legalny ruch: brak ! i !!.
2. Oczywiste odbicie hetmana, ogromna różnica best–second: brak pochwały.
3. Nietypowe odbicie z udowodnioną kombinacją może przejść filtr.
4. Rzadki ruch, ale wiele łatwych dobrych alternatyw: brak greatFind.
5. Jedyna trudna obrona, pełne pokrycie alternatyw: możliwe !.
6. +10 -> +7 i bezpieczna wymiana: brak ?!/?, możliwe goodSimplification.
7. Te same reguły dla czarnych z poprawnym znakiem oceny.
8. Uproszczenie do pata/remisu nie otrzymuje pochwały i wykazuje utratę wyniku.
9. Wygrana zamiast szybszego mata: brak automatycznej kary.
10. Kuszący zły ruch Mai: naturalMistake nie zmienia kategorii jakości.
11. Nieoceniona masa ruchów uniemożliwia nieuzasadnione „jedyny” i !.
12. Kategorie na dokładnych granicach 2/5/10/20 są jednoznaczne.
13. Niestabilna ocena: status wstępny, brak !!.
14. Brak wyniku silnika: brak fikcyjnej oceny i statystyk.
15. Alternatywna dobra odpowiedź w ćwiczeniu jest akceptowana.
16. Analiza z kursorem w środku obejmuje dalszy ciąg i nie usuwa drzewa.
17. Edycja/anulowanie podczas pracy nie zapisuje starych wyników do nowej gry.
18. Powtórzenia i reguła 50 posunięć są respektowane.
19. Telefon: płynna plansza, brak overflow, działające stop/wznów i brak
    podpowiedzi zdradzających ćwiczenie w innych panelach.
20. Krótka partia bez decyzji diagnostycznych: brak zmyślonego Elo.

## 15. Źródła i granice zapożyczeń

- Chess.com, klasyfikacja i expected points:
  https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc
- Chess.com, recenzja i ponowne próby:
  https://support.chess.com/en/articles/8584089-how-does-game-review-work
- Chess.com, ocena występu:
  https://support.chess.com/en/articles/10773754-how-is-game-rating-calculated-in-game-review
- Lichess, publiczna metryka dokładności i odnośniki do kodu:
  https://lichess.org/page/accuracy
- Oficjalne modele i implementacja Maia3:
  https://github.com/CSSLab/maia3
- Maia Chess, analiza i trening:
  https://www.maiachess.com/

Progi trudności, tagi i pipeline powyżej są naszym projektem v1, a nie
deklaracją identyczności z tymi serwisami. Korzystając z ich kodu lub danych,
sprawdź licencję i zachowaj wymagane informacje o autorstwie. Nie deklaruj
zgodności liczbowej z Chess.com na podstawie samych publicznych progów.
