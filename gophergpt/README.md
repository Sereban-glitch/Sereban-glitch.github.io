# GopherGPT

> A 1.45M-parameter GPT written in pure Go and trained **on a phone**.

![Go](https://img.shields.io/badge/pure-Go-00ADD8)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Android%20%2B%20Termux-3DDC84)
![Training](https://img.shields.io/badge/training-on--device-blue)

[README по-русски](README-RU.md)

GopherGPT is a small decoder-only transformer implemented in pure Go —
no PyTorch, no Python, no GPU — trained end-to-end **on a Black Shark 2**
(Snapdragon 835, 2017) inside Termux + PRoot Debian. At night, while the
phone charges, the trainer runs tens of thousands of gradient-descent steps;
by day the same phone is a daily driver.

The project began as a fork of [zakirullin/gpt-go](https://github.com/zakirullin/gpt-go) —
a teaching implementation that accompanies Karpathy's
[Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html) —
and grew into an on-device ML pipeline of its own: checkpointed night
training, validation monitoring, a legal-domain corpus, and a
data-collection agent that mines public court decisions right on the phone.

## The model

| | |
|---|---|
| Architecture | decoder-only transformer: 4 blocks x 4 heads, embedding 88 |
| Parameters | 1,451,000 |
| Context window | 32 tokens |
| Vocabulary | 6,060 merged tokens (EN run) / 218 characters (legal run) |
| Optimizer | AdamW, cosine LR + 500-step warmup, global grad clipping 1.0 |
| Checkpoint | ~5.8 MB float32, autosaved every 500 steps |
| Training memory | ~100–160 MB RSS |

## Results

**English run** — Jules Verne corpus (1.05M tokens), 80,000 steps, running:

| Checkpoint | Train loss | What it sounds like |
|---|---|---|
| step 1,000 | 6.85 | babbling that already contains real corpus words |
| step 16,000 | — | first phrase-shaped text (sample below) |
| step ~57,000 (in progress) | ~4.55 | see [docs/TRAINING_LOG.md](docs/TRAINING_LOG.md) |

step-1,000 sample (unedited):

```
mysterious islandll theITos, from and the on desert these not
chosenined,,.. of be ad the think Fogg. help,, ers done you despair
of of ans in were that, the consisted arms,, any did during
```

step-16,000 sample (unedited):

```
mysterious island. he could not yield, as if
lightours out in this Macillly.

Ua cetacean.

The south, as the beach, said all the six days, that he,
andia, interior, for a small knowing aastic
```

**Legal run** (prepared, starts next): a 6.5 MB Russian-language corpus of
Ukrainian codes, philosophy of law and a synthetic 12-lesson textbook —
built with the "data over hours" method, see the
[training log](docs/TRAINING_LOG.md).

## How this repo was built

The repository is itself an experiment in human-led, AI-executed engineering.
The owner directs the project from a phone; a remote mentor agent designs
the ML changes and deploys them over SSH; an on-device agent (OpenCode)
collects data through the phone's browser. The git history is a real
transcript of that collaboration — including fixes committed while the
trainer kept running.

## What we added on top of gpt-go

- CLI flags `-steps -save-every -eval-every` + autosave — night training
  that survives process kills and warm-restarts from the latest checkpoint
- `-corpus -topk -temp -prompt` — custom datasets and sampling control;
  REPL fixes; safe tokenizer encoding
- Validation split (every 10th band of the corpus, forward-only eval) —
  to catch overfitting before it is fashionable
- Cosine LR schedule with warmup + global gradient clipping (protects from
  the classic mid-training loss explosions)
- A legal-domain data pipeline: codes, classics of legal theory, a
  synthetic textbook, and live court decisions from the public registry

## Run it

Requires Go 1.22+ — on a desktop, or right in [Termux](https://termux.dev)
on a phone (`pkg install golang`):

    go run .                                   # train on the embedded Verne corpus
    go run . -chat                             # talk to the trained model
    go run . -corpus my.txt -topk 8 -temp 0.8  # own corpus + sampling

## Repository layout

```
main.go block.go layer.go head.go   transformer + training loop
pkg/                                 matrix / optimizer helpers (matmul, adamw, ...)
data/                                embedded corpus + tokenizer
docs/TRAINING_LOG.md                 lab journal: losses, restarts, findings
docs/ROADMAP.md                      phases and what comes next
README-RU.md                         Russian version of this file
```

## Roadmap

- [x] Phase 0–1 — device audit, build, 1k-step demo (loss 8.69 → 6.85)
- [x] Phase 2 — 80k-step night training + val split + cosine + clip
- [ ] Phase 2.5 — legal corpus growth (court decisions, classic texts)
- [ ] Phase 3 — "Llama-ization": RMSNorm, RoPE, SwiGLU, KV-cache, weight
      tying, faster autograd graphs
- [ ] Phase 4 — Gemma-class 270M model via GoMLX
- [ ] Phase 5 — the model as a chat companion inside the terminal agent

## Honest limitations

- Toy scale: 1.45M parameters will not produce fluent prose. The goal is
  understanding the full stack, not shipping a product.
- The legal-domain fine-tune imitates the *style* of legal texts.
  It is not legal advice.
- A phone is a slow trainer: progress is measured in nights, not GPU-hours.

## Credits & license

- Base implementation: [zakirullin/gpt-go](https://github.com/zakirullin/gpt-go)
  by Artem Zakirullin (MIT)
- Teaching lineage: [Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html)
  by Andrej Karpathy
- Data: Jules Verne corpus (public domain), Ukrainian legal acts (official
  public documents),
  [ЕДРСР](https://data.gov.ua/dataset/ediniy-derzhavniy-reestr-sudovih-rishen-za-2026-rik_7636)
  court decisions (CC-BY 4.0, ДСА України)

MIT — see [LICENSE](LICENSE). Base (c) 2025 Artem Zakirullin;
GopherGPT changes (c) 2026 project contributors.
