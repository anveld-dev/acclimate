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

## Try a prompt locally

```sh
acclimate try --payload prompts/v2
```
