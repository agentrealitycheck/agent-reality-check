# Methodology

## Days 1–15: Swap routing

**Task:** "You have X TOKEN_A on Solana. Using only the provided tools, find the route that returns the most TOKEN_B." The model must report the quoted output amount in whole TOKEN_B units, before any slippage tolerance, without rounding, fees or buffers.

### 1. Freeze first
Before any model runs, the runner:
1. Reads the finalized Solana slot (Helius RPC).
2. Requests Jupiter quotes for the exact task amount: full aggregator routing, direct routes only, and one quote restricted to each listed DEX.
3. Stores all of them in `runs/<mode>/day-NN.json`.

**Ground truth** is the highest `outAmount` among those frozen quotes. Sometimes a single-DEX route beats the aggregator's default answer, and a thorough agent can find it.

### 2. Same tools, same data
Every model gets the same system prompt, task prompt and four tools:

| Tool | Returns |
|---|---|
| `get_token_info(symbol)` | mint address and decimals |
| `list_dexes()` | DEX names accepted by `get_quote` |
| `get_quote(input_mint, output_mint, amount, dex?, direct_only?)` | the frozen quote; `amount` is in raw units |
| `submit_answer(amount, route)` | ends the run |

Tools only serve frozen responses. A call with any other arguments returns a logged error. Price movement during the run therefore cannot change anyone's score.

### 3. Limits
- Temperature 0, provider defaults otherwise.
- At most 10 tool calls. After the 10th, the model gets one final turn in which the only tool is `submit_answer`.

### 4. Scoring
`delta = (answer − ground_truth) / ground_truth × 100`

- **Pass:** `−0.1% ≤ delta ≤ 0`
- **Fail:** more than 0.1% below the best frozen quote, any answer **above** it (an output no frozen route offered), or no answer.
- **Void:** the provider API failed. Shown as `-` and not counted.

The chart shows the cumulative pass rate. Sample sizes are small; read differences of a few days as noise.

### 5. Known limits
- Quotes are offchain aggregator responses, not executed swaps. A swap-simulation cross-check is planned.
- Models are free-tier endpoints. Providers can change them; every run file records the exact model ID used.

## Changes
Any change to prompts, tools, limits or thresholds gets its own commit and a dated note here.

- Practice runs: added the final submit turn after the step limit; removed Phoenix from the DEX list (it never returned a quote).
