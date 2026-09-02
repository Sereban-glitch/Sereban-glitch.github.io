package main

import (
        "bufio"
        "flag"
        "fmt"
        "math"
        "os"
        "sort"
        "strings"

        "github.com/itsubaki/autograd/variable"
        "github.com/zakirullin/gpt-go/data"
        "github.com/zakirullin/gpt-go/pkg"
)

// Hyperparameters
const (
        blockSize        = 32
        embedSize        = 88
        heads            = 4
        layers           = 4
        learningRate     = 0.0001
        dropout          = 0.0   // disable some % of our neurons to prevent overfitting, model is likely to generalize
        pretrainedTokens = 6000  // number of pretrained tokens to add on top of auto-detected characters
        maxTokens        = 50    // tokens limit for generation
)

// 🇷🇺 GopherGPT: наши параметры командной строки (флаги).
// Запускать так: ./gophergpt-bin -steps 1000 -save-every 250
var (
        steps     = flag.Int("steps", 80000, "сколько шагов тренировки сделать (больше = умнее модель, но дольше)")
        saveEvery = flag.Int("save-every", 1000, "автосохранение весов каждые N шагов (защита от прерываний)")
        evalEvery = flag.Int("eval-every", 1000, "как часто печатать средний loss (для наблюдения за прогрессом)")

        // 🇷🇺 GopherGPT, Фаза 2: корпус с диска, сэмплирование, промт.
        corpus = flag.String("corpus", "", "путь к файлу корпуса .txt (пусто = вшитый корпус Жюль Верна)")
        prompt0 = flag.String("prompt", "", "первый промт чата (по умолчанию ' mysterious island')")
        topk    = flag.Int("topk", 0, "top-k сэмплирование: 0 = выкл, N = только N самых вероятных токенов")
        temp    = flag.Float64("temp", 0.8, "температура сэмплирования (меньше = предсказуемее, 0.5-1.0)")

        // 🇷🇺 GopherGPT, Фаза 2.1 «зоркость»: валидация + расписание lr + клип.
        warmup = flag.Int("warmup", 500, "прогрев: N первых шагов скорость обучения плавно растёт от нуля")
        clipN  = flag.Float64("clip", 1.0, "клиппинг градиентов: глобальная L2-норма не выше N (0 = выкл)")
        valb   = flag.Int("valb", 32, "сколько батчей брать для оценки val-loss при каждой печати")
)

func main() {
        // Skip training if "-chat" flag is provided.
        chat := flag.Bool("chat", false, "Skip training and jump straight to chat")
        flag.Parse()
        if *chat {
                *steps = -1
        }
        if *evalEvery < 1 {
                *evalEvery = 1
        }
        if *saveEvery < 1 {
                *saveEvery = 1
        }
        if *valb < 1 {
                *valb = 1
        }

        // Loading dataset and building vocabulary.
        // 🇷🇺 GopherGPT, Фаза 2: корпус можно подать с диска (-corpus).
        // Новый корпус получает посимвольный словарь (merge-правила
        // вшитого словаря применимы только к английскому тексту).
        merges := pretrainedTokens
        if *corpus != "" {
                raw, err := os.ReadFile(*corpus)
                if err != nil {
                        fmt.Println("не могу прочитать корпус:", err)
                        os.Exit(1)
                }
                data.SetDataset(string(raw))
                merges = 0
                fmt.Printf("Corpus: %s (%.2fM символов, посимвольный словарь)\n", *corpus, pkg.Millions(len(raw)))
        }
        fmt.Println("Tokenizing dataset...")
        dataset, vocabSize := data.Tokenize(merges)
        fmt.Printf("First characters:\n%s\n", strings.TrimSpace(data.Decode(dataset[:45]...)))
        fmt.Printf("Vocabulary: %s\n", data.Chars())
        fmt.Printf("Tokens in dataset: %.3fM\n", pkg.Millions(len(dataset)))

        // 🇷🇺 GopherGPT, Фаза 2.1 «зоркость»: чересполосное деление train/val.
        // Каждая 10-я полоса из 33 токенов уходит в val (~10% текста) — так
        // валидация равномерно покрывает ВЕСЬ корпус (кодексы, философию,
        // учебник), а не один хвост. Модель никогда не учится на val — это
        // наши «часы качества»: пока val-loss падает — модель учится
        // ПОНИМАТЬ текст; когда train падает, а val встаёт или растёт —
        // модель начала ЗАУЧИВАТЬ корпус (зубрёжка), дальше учить нет смысла.
        trainData, valData := splitTrainVal(dataset, blockSize)
        fmt.Printf("train tokens: %.3fM, val tokens: %.3fM\n", pkg.Millions(len(trainData)), pkg.Millions(len(valData)))

        // Basic transformer components.
        tokEmbeds := RandEmbeds(vocabSize, embedSize)
        posEmbeds := RandEmbeds(blockSize, embedSize)
        var blocks []*Block
        for range layers {
                blocks = append(blocks, NewBlock(embedSize, heads))
        }
        norm := NewLayerNorm(embedSize)
        lmHead := NewLinear(embedSize, vocabSize)

        // Collecting all the parameters.
        params := pkg.NewParams()
        params.Add(tokEmbeds, posEmbeds)
        for _, block := range blocks {
                params.Add(block.Params()...)
        }
        params.Add(norm.Params()...)
        params.Add(lmHead.Params()...)
        params.TryLoadPretrained()
        fmt.Printf("Model size: %.3fM\n", pkg.Millions(params.Count()))

        // 🇷🇺 GopherGPT, Фаза 2.1: единый проход вперёд — используется и в
        // тренировке, и в валидации, и в чате. Один код — одна правда.
        forward := func(input *variable.Variable) *variable.Variable {
                embeds := Rows(tokEmbeds, Flat(input)...) // get embed for every input token
                embeds = Add(embeds, posEmbeds)           // add positional embedding
                for _, block := range blocks {            // self-attention and feed-forward
                        embeds = block.Forward(embeds)
                }
                embeds = norm.Forward(embeds)
                return lmHead.Forward(embeds) // get scores for the next token for every context-enriched embed
        }

        // 🇷🇺 GopherGPT, Фаза 2.1: честная валидация — только проход вперёд,
        // без Backward: равноудалённые батчи по val-выборке, средний лосс.
        evalLoss := func(d []float64, batches int) float64 {
                span := len(d) - blockSize - 1
                if span < 1 || batches < 1 {
                        return math.NaN()
                }
                step := max(1, span/batches)
                var sum float64
                used := 0
                for off := 0; off < span && used < batches; off += step {
                        input := variable.New(d[off : off+blockSize]...)
                        targets := variable.New(d[off+1 : off+1+blockSize]...)
                        loss := SoftmaxCrossEntropy(forward(input), targets)
                        sum += Val(loss)
                        used++
                }
                return sum / float64(used)
        }

        // 🇷🇺 GopherGPT, Фаза 2.1: расписание скорости обучения.
        // Прогрев (первые warmup шагов lr растёт от нуля — защита от
        // взрыва градиентов на старте) + косинусное затухание к концу
        // (финишная прямая: маленькие шаги точнее «дошлифовывают» веса).
        // Приём из nanoGPT-спидранов и книги Рашки (прил. Г).
        lrAt := func(i int) float64 {
                total := *steps
                if total < 1 {
                        total = 1
                }
                w := *warmup
                if w < 1 {
                        w = 1
                }
                warm := min(1.0, float64(i+1)/float64(w))
                progress := float64(i) / float64(total)
                cos := 0.5 * (1 + math.Cos(math.Pi*progress))
                return learningRate * warm * cos
        }

        // 🇷🇺 GopherGPT, Фаза 2.1: клиппинг градиентов по глобальной норме.
        // Если суммарный «импульс» всех градиентов превышает clipN —
        // аккуратно уменьшаем его, чтобы оптимизатор не делал гигантский
        // шаг и не портил веса (классика против «взрывов градиентов»).
        clipGrads := func(limit float64) {
                if limit <= 0 {
                        return
                }
                var sq float64
                for _, p := range params.Params() {
                        if p.Grad == nil {
                                continue
                        }
                        for _, row := range p.Grad.Data {
                                for _, g := range row {
                                        sq += g * g
                                }
                        }
                }
                norm := math.Sqrt(sq)
                if norm <= limit || norm == 0 {
                        return
                }
                scale := limit / norm
                for _, p := range params.Params() {
                        if p.Grad == nil {
                                continue
                        }
                        for _, row := range p.Grad.Data {
                                for j, g := range row {
                                        row[j] = g * scale
                                }
                        }
                }
        }

        // Training loop.
        losses := 0.0
        optimizer := pkg.NewAdamW(learningRate)
        fmt.Printf("bs=%d, es=%d, lr=%.4f, warmup=%d, clip=%.1f, vs=%d, steps=%d\n", blockSize, embedSize, learningRate, *warmup, *clipN, vocabSize, *steps)
        for i := 0; i < *steps; i++ {
                // Targets contain the ground truth next token for each input token.
                // 🇷🇺 Фаза 2.1: семплируем ТОЛЬКО из train — val неприкосновенна.
                input, targets := data.Sample(trainData, blockSize)

                // Forward pass, calculate predictions for every input token.
                logits := forward(input)

                // Loss calculation, "how much our predicted targets differ from the ground truth targets?"
                // We average the loss over evalSteps iterations to smooth out fluctuations.
                loss := SoftmaxCrossEntropy(logits, targets)
                losses += Val(loss)
                fmt.Printf("\r%s", strings.Repeat("·", (i%*evalEvery)*26/(*evalEvery))) // progress bar
                if i%*evalEvery == 0 {
                        avgLoss := losses / float64(min(i+1, *evalEvery))
                        valLoss := evalLoss(valData, *valb)
                        fmt.Printf("\rstep: %5d, loss: %.4f, val: %.4f, lr: %.2e\n", i, avgLoss, valLoss, lrAt(i))
                        losses = 0
                }

                // 🇷🇺 GopherGPT, улучшение №1: автосохранение весов во время тренировки.
                // В оригинале веса сохранялись только ПОСЛЕ всех 80000 шагов —
                // если тренировку прервать (звонок на телефоне, села батарея, Ctrl+C),
                // весь прогресс сгорал бы. Теперь каждые saveEvery шагов веса
                // пишутся на диск, а следующий запуск подхватит их через
                // TryLoadPretrained и продолжит с того же места.
                if i > 0 && i%*saveEvery == 0 {
                        params.Save()
                }

                // Backward pass, calculate the gradients (how much each parameter contributes to the loss)
                // for all the parameters (weights, biases, embeds). Loss is the tail of a computation graph.
                loss.Backward()
                // 🇷🇺 Фаза 2.1: сначала укрощаем градиенты, потом делаем шаг
                // с текущей скоростью обучения (прогрев + косинус).
                clipGrads(*clipN)
                optimizer.Alpha = lrAt(i)
                // Nudge the parameters in the direction of the gradients, so to minimize the loss.
                optimizer.Update(params)
                params.ZeroGrad()
        }
        params.Save()
        pkg.DisableDropout()
        // Training is done.

        // Predicts the next token based on the context of tokens.
        nextTok := func(context []float64) float64 {
                context = context[max(0, len(context)-blockSize):]
                logits := forward(variable.New(context...))

                // We only care about the probabilities of the next token for the last token.
                logitsForNextToken := Rows(logits, -1)
                probs := Softmax(logitsForNextToken)
                // 🇷🇺 GopherGPT, Фаза 2: top-k — обрезаем хвост распределения,
                // чтобы модель не выбирала экзотические токены.
                if *topk > 0 {
                        probs = TopK(probs, *topk)
                }
                tok := pkg.SampleTemp(probs, *temp)

                return tok
        }

        // Sample from the model.
        // 🇷🇺 GopherGPT, фикс REPL: сканер создаётся ОДИН раз до цикла.
        // Раньше новый bufio.Scanner в каждом витке терял строки,
        // забуференные вперёд предыдущим сканером; на EOF промт
        // становился пустым и следующий Encode паниковал на пустом
        // контексте. Теперь: EOF = аккуратный выход, незнакомые
        // символы заменяются пробелом (EncodeSafe), пустой промт
        // просто пропускает генерацию.
        prompt := " mysterious island"
        if *prompt0 != "" {
                prompt = *prompt0
        }
        scanner := bufio.NewScanner(os.Stdin)
        for {
                fmt.Printf("\n%s", prompt)
                context := data.EncodeSafe(prompt)
                if len(context) == 0 {
                        fmt.Println("\n(в промте нет знакомых модели символов)")
                }
                for i := 0; i < maxTokens && len(context) > 0; i++ {
                        nextToken := nextTok(context)
                        fmt.Print(data.Decode(nextToken))
                        context = append(context, nextToken)
                }

                fmt.Print("\n$ ")
                if !scanner.Scan() {
                        fmt.Println("\nBye!")
                        break
                }
                prompt = scanner.Text()
                if prompt == "exit" {
                        fmt.Println("Bye!")
                        break
                }
        }
}

// 🇷🇺 GopherGPT, Фаза 2.1: чересполосное деление корпуса train/val.
// Ходим по корпусу полосами по (blockSize+1) токенов: каждая 10-я полоса
// уходит в val, остальные — в train. Получаем ~10% валидации, равномерно
// размазанной по всему тексту (не только по последнему автору/книге).
func splitTrainVal(tokens []float64, block int) (train, val []float64) {
        const valEvery = 10
        stride := block + 1
        n := 0
        for i := 0; i+stride <= len(tokens); i += stride {
                chunk := tokens[i : i+stride]
                if n%valEvery == valEvery-1 {
                        val = append(val, chunk...)
                } else {
                        train = append(train, chunk...)
                }
                n++
        }
        // Хвост короче полосы отдаем train, чтобы не терять токены.
        if start := n * stride; start < len(tokens) {
                train = append(train, tokens[start:]...)
        }
        return train, val
}

// 🇷🇺 GopherGPT, Фаза 2: top-k сэмплирование. Оставляем k самых
// вероятных токенов, остальным обнуляем вероятность и перенормируем
// распределение. Классический приём больших LLM против «лепета хвостом».
func TopK(probs *variable.Variable, k int) *variable.Variable {
        vals := probs.Data[0]
        if k >= len(vals) {
                return probs
        }

        idx := make([]int, len(vals))
        for i := range idx {
                idx[i] = i
        }
        sort.Slice(idx, func(a, b int) bool { return vals[idx[a]] > vals[idx[b]] })

        sum := 0.0
        keep := make(map[int]bool, k)
        for i := 0; i < k; i++ {
                keep[idx[i]] = true
                sum += vals[idx[i]]
        }

        out := make([]float64, len(vals))
        for i, v := range vals {
                if keep[i] {
                        out[i] = v / sum
                }
        }

        return variable.NewOf(out)
}
