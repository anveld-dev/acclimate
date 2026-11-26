# Gear returns

A returns desk for an outdoor gear shop learns the shop's policy as labelled tasks arrive in batches, the way corrections arrive from a live agent. After each batch, a fixed test set the loop never sees measures the released version. This run is the chart on the docs home page.

The starting instructions name the five outcomes, `REFUND`, `EXCHANGE`, `STORE_CREDIT`, `REPAIR` and `DENY`, and none of the policy. The policy has nine rules, such as a 60-day window with store credit until day 90, a 365-day window for members, repair for faults within two years, and exchange only for footwear worn outdoors. `generate.py` holds the policy and writes every task.

| File | Contents |
| --- | --- |
| `bundle/instructions.md` | The starting instructions. |
| `stages/1.csv` to `stages/4.csv` | 102 tasks in four batches. Batch 1 covers plain returns and three rules, each later batch two more. |
| `test.csv` | 60 tasks covering every rule. The script never imports them. |
| `generate.py` | The hidden policy and the generator. It picks seeds so each batch splits the way the run needs. |
| `run.ts` | Publishes the bundle, imports each batch, waits for the loop to settle and scores the released version on `test.csv`. |
| `results.json` | The recorded run. |

## Run it

The script needs what the [ticket triage example](../ticket-triage/README.md#run-it) needs: a service with an optimizer and an executor, a verified model provider, and `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE`, `ACCLIMATE_TOKEN` (read, write and promote), `TASK_MODEL` and `JUDGE_MODEL`. It also calls the task model itself to score the test set, through `OPENAI_BASE_URL` and `OPENAI_API_KEY`. On the local stack, `source .local/stack/env.sh` sets all but the token.

```sh
npm run example:gear-returns
```

The script writes `results.json` after each batch. Running it again resumes the bundle named by `ACCLIMATE_BUNDLE_NAME` (default `Gear returns`) after the last recorded batch.

## The recorded run

Task model `gpt-6-luna`, optimizer `gpt-6.2-astra` at high reasoning effort, on the local stack through an OpenAI-compatible proxy. Each test task was answered three times.

| | Pass rate on `test.csv` | Rounds |
| --- | --- | --- |
| Starting instructions | 48% | |
| After batch 1 (plain returns, rentals, used climbing gear, return windows) | 58% | 1 to 5: one failed when the model proxy stopped, two adopted, two kept |
| After batch 2 (final sale, gifts without a receipt) | 77% | 6 to 8: one adopted, two kept |
| After batch 3 (worn footwear, opened electronics) | 97% | 9 to 13: two adopted, three kept |
| After batch 4 (used ordinary gear, faults) | 97% | 14 to 18: three adopted, two kept |

Answering `STORE_CREDIT` to everything passes 35% of the test set. The run took about five hours, 21,899 rollouts, 9.4 million task-model tokens and 26.7 million optimizer tokens. The loop's own held-out tasks, drawn from each batch, ended at 100%.

The released instructions state the policy as ordered rules. One is wrong: they give members a refund for 180 days, where the policy allows 365.
