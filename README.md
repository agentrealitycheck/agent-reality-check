# Agent Reality Check

A daily, open-source benchmark: **can AI agents do simple crypto tasks?**

Every day, five AI models get the same Solana task and the same tools. Every tool response and the ground truth are frozen at one slot before any model runs, so every model sees identical data and the score is reproducible. Every step of every model is published.

- **Site:** `site/` (static HTML, data in `site/data.js`)
- **Runner:** `runner/run.py` (Python standard library only)
- **Evidence:** `runs/` (frozen quotes, full model messages and raw API responses for every day)
- **Rules:** [METHODOLOGY.md](METHODOLOGY.md)

## Models

| Model | Vendor | Served by |
|---|---|---|
| Gemini 3.5 Flash | Google | Google AI Studio |
| GPT-OSS 120B | OpenAI (open weights) | Groq |
| Qwen 3.8 27B | Alibaba (open weights) | Groq |
| Nemotron 3 Ultra | NVIDIA (open weights) | OpenRouter |
| Gemma 4 31B | Google (open weights) | Google AI Studio |

Exact model IDs are pinned in `runner/config.json` and recorded in every run file.

## Run it yourself

```bash
cp runner/.env.example runner/.env   # add your own keys
python runner/run.py check           # test keys, models and data sources
python runner/run.py run --mock      # full pipeline offline, no keys needed
python runner/run.py run             # a real run
```

## Not affiliated

Independent project. Not affiliated with, sponsored or endorsed by any model provider, DEX or aggregator.
