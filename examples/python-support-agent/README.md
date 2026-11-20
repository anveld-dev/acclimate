# Python support agent example

A small customer-support agent that you can evaluate with Acclimate without a model provider or network access. The agent looks up knowledge-base articles and calls a fake model. The fake model follows directives in the system prompt, so a prompt change changes its answers the way it would with a real model.

| File | Contents |
| --- | --- |
| `support_agent.py` | Keyword retrieval, the fake model call and the scoring function. |
| `knowledge_base.json` | Four help articles. |
| `application.py` | The evaluation adapter: `cases`, `execute` and `grade`. |
| `cases.json` | Five saved cases with expected articles and escalation behavior. |
| `prompts/v1/`, `prompts/v2/` | Two versions of the agent's instructions. Version 2 asks the agent to cite its source and to escalate questions the knowledge base doesn't cover. |
| `bundle_files.py` | Turns a prompt directory into a bundle payload and publishes the first version. |

## Set up

Use Python 3.11 or later.

```sh
cd examples/python-support-agent
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

To use the SDK from this checkout instead, run `pip install ../../python`. For an air-gapped machine, install the release wheel with `pip install --no-index --no-deps /path/to/acclimate_sdk-0.1.0-py3-none-any.whl`.

## Describe the evaluation

```sh
acclimate describe
```

`describe` loads `application.py` and prints the public descriptor: revision hashes for the cases, grader and code, plus the five case IDs. Inputs and expected answers stay private. `python -m acclimate describe` runs the same command.

## Compare the two prompts locally

```sh
acclimate compare --local --parent prompts/v1 --candidate prompts/v2
```

A local comparison runs every case against both prompt directories on this machine and grades each answer. It needs no service or credentials. With `prompts/v1` the agent omits citations and guesses an answer for the tax question. With `prompts/v2` it cites the article and hands the tax question to a human, so every case should score 1.

## Run the same comparison through the service

A live comparison records evidence in your workspace so a reviewer can approve the release.

1. Publish version 1 to the `stable` channel. This needs a token with write and release access.

   ```sh
   export ACCLIMATE_URL=https://acclimate.example.com
   export ACCLIMATE_WORKSPACE=your-workspace-id
   export ACCLIMATE_TOKEN=...   # keep this out of shell history
   python bundle_files.py publish prompts/v1 --channel stable
   ```

   The command prints the new `bundleId`.

2. Write the candidate payload and check the evaluator setup. Ask your operator for an evaluator configuration file.

   ```sh
   python bundle_files.py payload prompts/v2 > candidate.json
   acclimate doctor --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID"
   ```

3. Compare. Give the run a name, and repeat the same command to recover it if it's interrupted.

   ```sh
   acclimate compare --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --channel stable \
     --payload candidate.json --name cite-and-escalate --live
   acclimate status --config "$EVALUATOR_CONFIG" --name cite-and-escalate
   ```

The comparison appears in the console for review. Add `--policy quality-policy.json` to apply a quality policy. Copy one from the [Python evaluation starter](../python-evaluation-starter/quality-policy.example.json).

## Use your own agent

Replace `fake_model` in `support_agent.py` with your model client and keep the rest. `execute` already passes the instructions from the version under test as the system prompt. For a blank adapter, start from the [Python evaluation starter](../python-evaluation-starter/README.md).
