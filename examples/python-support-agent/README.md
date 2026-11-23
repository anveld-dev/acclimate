# Python support agent example

A small customer-support agent that you can evaluate with Acclimate without a model provider or network access. The agent looks up knowledge-base articles and calls a fake model. The fake model follows directives in the system prompt, so a prompt change changes its answers the way it would with a real model.

| File | Contents |
| --- | --- |
| `support_agent.py` | Keyword retrieval, the fake model call and the scoring function. |
| `knowledge_base.json` | Four help articles. |
| `cases.json` | Five saved cases with expected articles and escalation behavior. |
| `prompts/v1/`, `prompts/v2/` | Two versions of the agent's instructions. Version 2 asks the agent to cite its source and to escalate questions the knowledge base doesn't cover. |
| `bundle_files.py` | Turns a prompt directory into a bundle payload and publishes the first version. |

## Set up

Use Python 3.11 or later.

```sh
cd examples/python-support-agent
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install ../../python
```

To use a verified release wheel, run `python -m pip install --no-index --no-deps /path/to/acclimate_sdk-0.1.0-py3-none-any.whl`. The pinned `requirements.txt` works after that SDK version is published to PyPI.

## Publish the instructions

Run `python bundle_files.py payload prompts/v1` to inspect the bundle. With workspace credentials configured, run `python bundle_files.py publish prompts/v1` to release it.
