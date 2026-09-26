# Audyt analizy i projekt raportu

Data: 2026-09-24. Przegląd statyczny implementacji; bez uruchamiania partii
w przeglądarce. Dokument uzupełnia game-analysis-spec.md. Ćwiczenia poza zakresem.

### Stan po wdrożeniu

Wdrożono komponent GameReport, model podsumowań, wykres przewagi z lukami
i oznaczeniami matów, przybliżone fazy na podstawie materiału/rozwoju,
klikalne momenty i wskazówki. Dodano sześciopunktowy eksperymentalny profil
Mai (minimum 12 diagnostycznych decyzji), rating przeciwnika z PGN lub jawny
poziom referencyjny, ocenę alternatyw i przedział masy dobrych ruchów.
Stockfish pogłębia krytyczne pozycje; Maia działa w workerze. Raport ma
schemat 2; starsze raporty wymagają ponownego przeliczenia.

Ograniczenia tej wersji: profil Mai nie jest skalibrowanym Elo; brak
przedziałów ufności i przeliczeń między platformami. Atak/obrona obejmują
potwierdzony atak matowy oraz policzone szachy/odpowiedzi na szach, bez
udawania pełnej analizy inicjatywy strategicznej. Fazy są heurystyczne.
Nie wdrożono kalibracji na zbiorze partii, profilu wielopartiowego ani ćwiczeń.

## 1. Co wymaga poprawy w obecnej implementacji

1. App.tsx, maiaPlayerSummaries: średnia prawdopodobieństw zagranych ruchów
   opisuje zgodność wyborów z jednym ustawieniem Mai. Nie mierzy siły gry.
   Nie ma estymatora ratingu ani profilu dla różnych ratingów.
2. Wykres raportu pokazuje lossPoints każdego półruchu. Nie pokazuje przewagi,
   strony dominującej ani faz. Brak danych jest rysowany jak mała strata.
3. isObviousMoveForBaseline odrzuca wszystkie bicia, promocje i szachy.
   Wyklucza przez to trudne kombinacje, a przepuszcza banalne ciche ruchy.
4. maiaBaselineTag łączy rzadkość pojedynczego ruchu z jego stratą.
   Rzadki dobry wybór spośród wielu łatwych dobrych ruchów nie dowodzi odkrycia.
   Typowy ludzki błąd może natomiast nie dostać oznaczenia poniżej poziomu.
5. Oba zapytania Stockfisha mają limit najwyżej jednej sekundy, MultiPV=1.
   Brakuje pogłębiania krytycznych pozycji i oceny kuszących alternatyw.
   Status uncertain wynika z odległości od progu, a nie ze zbieżności obliczeń.
6. Dwie oceny matowe dają loss=0 bez porównania znaku; przejście między
   oceną liczbową i matową daje null. Potrzebna obsługa wyniku gry i strony,
   która matuje, niezależnie od długości mata.
7. Adapter Mai odwraca value dla czarnych do perspektywy białych, a opis
   raportu deklaruje perspektywę strony na ruchu. Ujednolicić kontrakt i UI.
8. excellent wynika wyłącznie z niewielkiej straty. To może być zwykły
   poprawny ruch; nie powinien mieć tej samej prezentacji co szczególne odkrycie.
9. Brak danych o fazach, inicjatywie, zagrożeniach i wykorzystanych szansach.
   Nie wystarczy dopisać narracji do obecnego zestawu pól.

## 2. Pierwszy ekran: odpowiedź na „jak zagrałem?”

Raport otwiera krótki tytuł opisujący rzeczywisty przebieg partii i jedno
zdanie z wnioskiem. Przykład formy, nie wynik analizy konkretnej partii:
„Dobra obrona, niewykorzystana szansa w końcówce”. Każdy wniosek prowadzi
do ruchu i wariantu stanowiącego jego podstawę.

Dwie karty zawodników:

- Szacowany poziom gry w tej partii: liczba/przedział, skala ratingowa,
  liczba diagnostycznych decyzji i jakość oszacowania.
- Dokładność według jawnie opisanej metody, oddzielona od ratingu.
- Trudne decyzje znalezione / dostępne, istotne błędy, wykorzystane szanse.
- Jedna konkretna mocna strona i jedna rzecz do poprawy, z odnośnikami.

Nie pokazywać średniej prawdopodobieństw Mai jako głównej statystyki.
Szczegóły silników, głębokości i prawdopodobieństw schować pod „Dlaczego?”.

## 3. Historia partii: przewaga i kluczowe momenty

Główny wykres to ciągła ocena pozycji z perspektywy białych, ze środkową
linią równowagi, nazwami stron i oznaczonymi fazami. Domyślnie czytelna
ograniczona skala przewagi; szczegóły pokazują surową ocenę SF lub mat.
Nie nazywać przekształconej oceny prawdopodobieństwem wygranej bez kalibracji.

Na wykresie zaznaczyć 3–5 najważniejszych momentów: przejęcie przewagi,
trudna obrona, przeoczona okazja, utrata wygranej, dobre uproszczenie.
Kliknięcie ustawia istniejącą planszę i zaznacza istniejący zapis ruchów.
Nie tworzyć drugiej listy ruchów. Braki danych to przerwy, nie zera.

Ruchy repertuarowe pozostają bez oceny jakości. Dla ciągłości wykresu można
osobno ocenić pozycje graniczne; nie wymyślać przebiegu między próbkami.
Zielony kolor oznacza przynależność do repertuaru, nie przewagę.

Pod wykresem karty faz: debiut, gra środkowa, końcówka, o ile wystąpiły.
Każda pokazuje przewagę na wejściu/wyjściu, kto dominował przez większość
fazy, jakość decyzji obu stron, liczbę błędów i kluczowy ruch.
Granicę faz określać z pozycji: rozwój, materiał, hetmany i aktywność królów;
sam numer ruchu jest tylko wskazówką. Dopuszczać fazy przejściowe i partie
zaczynające się od FEN. Nie wymuszać trzech faz w krótkiej partii.

## 4. Siła gry i estimated Elo

Najpierw liczyć osobno dla białych i czarnych profil prawdopodobieństwa
zagranych decyzji na siatce ratingów obsługiwanej przez model Maia.
Uwzględniać rating przeciwnika z PGN, a przy jego braku wspólnie dopasować
obie strony lub marginalizować rating przeciwnika. Nie ustawiać arbitralnie
tej samej siły obu graczom. Zachować metadane tempa i źródła ratingu.

Proponowany sygnał bazowy: ważona suma log P(zagrany ruch | pozycja,
rating gracza, rating przeciwnika). Prawdopodobieństwa nie muszą rosnąć
monotonicznie wraz z ratingiem; nie wyznaczać Elo pojedynczego ruchu
przez prostą odwrotność jego prawdopodobieństwa.

Ograniczyć wagę ruchów wymuszonych, repertuarowych, oczywistych odbić
i długich rozstrzygniętych fragmentów. Łączyć profil Mai z jakością SF
oraz trudnością decyzji. Kalibrować te cechy na osobnym zbiorze partii
o znanych ratingach i tempie, z rozdzieleniem graczy między zbiory.

Przed kalibracją można pokazać „profil najbardziej zbliżony do Maia X”,
wyraźnie oznaczony jako eksperymentalny, bez udawania ratingu FIDE/serwisu.
Docelowe „estimated Elo” wymaga określenia skali i walidacji błędu.
Płaski profil, maksimum na brzegu siatki lub za mało decyzji oznaczają
brak wiarygodnego oszacowania, nie pozornie precyzyjną liczbę.

W kolejnych fazach pokazywać przede wszystkim jakość decyzji i ich trudność.
Rating fazy tylko przy wystarczającej liczbie diagnostycznych decyzji.
Drugi, opcjonalny wykres pokazuje wygładzoną jakość gry każdej strony
w oknach decyzji; nie przedstawiać lokalnego wskaźnika jako chwilowego Elo.

## 5. „Znalazłeś” i „Przeoczyłeś” — najważniejsza część raportu

Każda karta zawiera ruch, jednozdaniowy wniosek, rzeczywistą konsekwencję
i klikalny wariant na istniejącej planszy. Porównanie: zagrano / można było.

- Trudne odkrycie: dobry ruch SF, mała łączna masa dobrych wyborów Mai,
  realna kusząca gorsza alternatywa, stabilna ocena. Nie sama rzadkość ruchu.
- Przeoczona szansa: istniał konkretny korzystny wariant; pokazać jego cel
  i moment, w którym różni się od zagranej linii.
- Poniżej poziomu: istotna strata przy dobrej odpowiedzi dostępnej zwykle
  graczom o oszacowanym poziomie. Rzadkość błędu nie jest warunkiem.
- Dobra obrona: utrzymanie pozycji przy małej liczbie dobrych odpowiedzi
  i konkretnym zagrożeniu. Może być najciekawszym ruchem partii.
- Dobre uproszczenie: utrzymana wygrana i potwierdzone zmniejszenie trudności
  lub kontrgry. +10 do +7 samo w sobie nie daje ani błędu, ani pochwały.

Filtr oczywistości analizuje poprzedni ruch i kontekst odbicia. Nie odrzuca
wszystkich bić/szachów/promocji. Dla oceny trudności badać SF najlepsze ruchy,
ruch zagrany i najbardziej prawdopodobne ruchy Mai. Zapisywać pokrycie
ocenionej masy; przy brakujących alternatywach nie twierdzić „jedyny ruch”.
Wyróżnienia względem poziomu gracza przeliczać po estymacji obu graczy;
unikać oceniania decyzji na podstawie profilu dopasowanego tylko do niej.

Rozdzielić jakość i wyjątkowość: zwykły poprawny ruch niebieski,
udowodnione odkrycie fioletowe z !, wątpliwy pomarańczowy, błędny czerwony.
Nie używać ~. !! dopiero po wdrożeniu osobnej weryfikacji kombinacji.

## 6. Kto atakował, kto się bronił?

Przewaga nie jest równoznaczna z atakiem. Zapisać osobne dane o inicjatywie:
zweryfikowane groźby, presja na króla, wymuszające kontynuacje, ograniczenie
dobrych odpowiedzi przeciwnika. Sama liczba szachów lub dodatnia ocena
nie wystarczą. Cechy pozycyjne generują hipotezę, wariant SF ją potwierdza.

Pokazywać pas pod wykresem: atak białych / obrona czarnych, kontratak,
walka manewrowa, realizacja przewagi. Tylko rozpoznane przedziały, z opisem
konkretnej groźby. Przy braku dowodów pozostawić brak etykiety.
Odseparować lokalny atak na króla od ogólnej inicjatywy i przewagi materialnej.

## 7. Implementacja i kolejność

1. Naprawić perspektywy ocen, maty, oczywistość, brakujące wyniki i semantykę
   kategorii. Wydzielić analysis/types, scheduler, classification, maia,
   phases, moments, performance oraz komponenty raportu z App.tsx.
2. Utrwalać niezmienny snapshot gry, historię, konfigurację, wersje silników,
   wyniki kandydatów i dowody wniosków. Nowy schemat raportu; stare raporty
   nie mogą udawać posiadania nowych danych. Anulowanie i cache per job.
3. Szybki przegląd SF, potem pogłębienie krytycznych i niestabilnych pozycji.
   Budżet zależny od złożoności i urządzenia, bez sztywnego limitu 1 s.
   Maia poza głównym wątkiem; stop i plansza pozostają responsywne.
4. Wdrożyć wykres przewagi, fazy, karty stron i 3–5 dowiedzionych momentów.
   To pierwszy samodzielny, atrakcyjny raport, bez czekania na kalibrację Elo.
5. Dodać wieloratingową Maię, trudność decyzji, eksperymentalny profil,
   następnie skalibrowane estimated Elo i porównania względem własnego poziomu.
6. Dodać inicjatywę i ostrożne podsumowania strategiczne. Narracja początkowo
   z szablonów opartych na dowodach; generator tekstu nie wylicza faktów.

Desktop: szeroki raport z wykresem i kartami, wygodny powrót do planszy.
Telefon: pełnoekranowy zamykany raport, karty w jednej kolumnie, szczegóły
rozwijane, wykres obsługiwany dotykiem. Sam raport może przewijać się wewnątrz;
ekran planszy nadal zachowuje widoczne komentarze i osobny scroll notacji.
Kliknięcie momentu zamyka/zwija raport i wraca do planszy; ponowne otwarcie
zachowuje miejsce. Nie dokładać szerokiej tabeli ani kolejnego zapisu ruchów.

Podczas pracy: osobno „przegląd partii”, „sprawdzanie kluczowych momentów”,
„profil graczy”; postęp i częściowe wyniki bez przedwczesnych !/!!.

## 8. Warunki odbioru

- Raport odpowiada, kto miał przewagę, kiedy i dlaczego ją stracił.
- Każda pochwała, przeoczenie i etykieta ataku prowadzi do dowodu na planszy.
- Oczywiste odbicie bez !; trudna kombinacja z biciem nie jest wykluczona.
- +10 do +7 nie jest automatycznie błędem; przejście do remisu jest zauważone.
- Ten sam przykład po zamianie kolorów daje symetryczny wynik.
- Profil Elo nie rośnie za same wymuszone odbicia; krótka partia ma uczciwy
  komunikat o niewystarczających danych. Przedziały wymagają kalibracji.
- Fazy nieistniejące nie są dopisywane. Brak danych nie udaje dobrej gry.
- Na telefonie można zatrzymać analizę, otworzyć moment i wrócić do raportu
  bez zmiany zapisu partii i bez poziomego przewijania.
