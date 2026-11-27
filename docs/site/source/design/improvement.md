# How improvement works

1. In workspace settings, configure an OpenAI-compatible model provider, its key and allowed models. After saving, check the verification result for each model. Each model must return token usage so the executor can enforce token limits.
2. Open the released bundle’s **Learning** tab. Choose its channel, task model and a different judge model.
3. Import CSV, JSONL, a spreadsheet or pasted examples. Each task pairs an input with an expected answer or grading criteria. Review any rows listed under the import with their source and reason for being set aside. Review the task cards and confirm held-out material. Use **Try** to inspect an executor run before starting a round.
4. Start learning once the provider is verified and at least 20 evolve tasks and 20 held-out tasks pass admission. The same floor applies on resume.

The executor runs each rollout in a fresh sandbox. The service scores candidates on evolve tasks, filters them with an empirical noise-adjusted score floor and task-token cost budget, and automatically releases the selected version to the channel. Held-out scores monitor regressions. Inspect the round, usage and release history in the console or roll back an adopted round.
