"""Frozen CLI support requests and reference argument vectors."""

FAMILIES = (
    ("logs list", [
        ("Show the newest entry matching 'retry budget', just the response.", "--query 'retry budget' --latest --response"),
        ("Export every log entry for model 'mini' as JSON.", "--model mini --count 0 --json"),
        ("Show five logs, include token usage, and expand fragment contents.", "--count 5 --usage --expand"),
        ("Show short YAML for the current conversation.", "--current --short"),
        ("Give me the last fenced code block from conversation 'chat-42'.", "--conversation chat-42 --extract-last"),
        ("Show entries containing results from both search and fetch tools.", "--tool search --tool fetch"),
        ("Return the first fenced code block from the latest response.", "--extract"),
    ]),
    ("models list", [
        ("List async models that support schemas.", "--async --schemas"),
        ("List models supporting tools and schemas as JSON.", "--tools --schemas --json"),
        ("Show options for models matching both 'mini' and 'openai'.", "--options --query mini --query openai"),
        ("List only models with IDs 'alpha' and 'beta'.", "--model alpha --model beta"),
        ("Produce JSON for asynchronous tool-capable models.", "--async --tools --json"),
        ("Show options for schema-capable models matching 'local'.", "--options --schemas --query local"),
        ("List tool-capable models matching 'gemini' and 'flash'.", "--tools --query gemini --query flash"),
    ]),
    ("schemas list", [
        ("List stored schemas matching 'invoice' and 'currency' in newline-delimited JSON.", "--query invoice --query currency --nl"),
        ("List stored schemas as JSON with full schema contents.", "--json --full"),
        ("Show full stored schemas matching 'postal address'.", "--full --query 'postal address'"),
        ("List schemas matching 'date' and 'timezone'.", "--query date --query timezone"),
        ("List schemas matching 'subtotal' as JSON.", "--query subtotal --json"),
        ("List all stored schemas in newline-delimited JSON.", "--nl"),
        ("Show full schema contents for schemas matching both 'customer' and 'email'.", "--full --query customer --query email"),
    ]),
    ("fragments list", [
        ("List only aliased fragments, as JSON.", "--aliases --json"),
        ("Search stored fragments for both 'release' and 'checklist'.", "--query release --query checklist"),
        ("Show only aliased fragments matching 'on call'.", "--aliases --query 'on call'"),
        ("Export stored fragments matching 'product brief' as JSON.", "--query 'product brief' --json"),
        ("List aliased fragments containing 'database' and 'migration'.", "--aliases --query database --query migration"),
        ("Export the full fragment inventory as JSON.", "--json"),
        ("List only fragments with aliases.", "--aliases"),
    ]),
    ("similar", [
        ("Find 4 neighbors of ID 'faq-19' in collection 'kb', plain text output.", "kb faq-19 --number 4 --plain"),
        ("Search collection 'notes' for 'cache invalidation', restricting IDs to the prefix 'ops-'.", "notes --content 'cache invalidation' --prefix ops-"),
        ("In 'archive', find 20 matches to 'wildfire response' using embeddings DB 'team.db'.", "archive --content 'wildfire response' --number 20 --database team.db"),
        ("Find 3 neighbors of 'doc-5' in 'papers' with IDs beginning '2025-'.", "papers doc-5 --number 3 --prefix 2025-"),
        ("Search 'support' for 'lost invoice' and print results as plain text.", "support --content 'lost invoice' --plain"),
        ("Find 8 neighbors of 'row-92' in 'tickets' using 'local.db'.", "tickets row-92 --number 8 --database local.db"),
        ("Search 'manuals' using text from stdin, returning two results.", "manuals --input - --number 2"),
    ]),
    ("logs list", [
        ("Output schema data as a JSON array, including source IDs.", "--data-array --data-ids"),
        ("Return schema data as newline-delimited JSON with source IDs.", "--data --data-ids"),
        ("Show logs for model 'fast' after response ID 'boundary'.", "--model fast --id-gt boundary"),
        ("Show logs starting at and including response ID 'cutoff', with long strings truncated.", "--id-gte cutoff --truncate"),
        ("Export JSON logs for conversation 'nightly' with expanded fragments.", "--conversation nightly --json --expand"),
        ("Show only logs with any tool results, with token usage.", "--tools --usage"),
        ("Search logs for prompts using the 'style' and 'rules' fragments.", "--fragment style --fragment rules"),
    ]),
    ("", [
        ("Print the path to the logs database.", "logs path"),
        ("Show the location of the directory holding templates.", "templates path"),
        ("List the installed fragment loaders.", "fragments loaders"),
        ("Print the location of the aliases file.", "aliases path"),
        ("Print the location of the API key file.", "keys path"),
        ("List installed template loaders.", "templates loaders"),
        ("Show the current logging status.", "logs status"),
    ]),
    ("", [
        ("List model aliases in JSON.", "aliases list --json"),
        ("List embedding models matching 'sentence'.", "embed-models list --query sentence"),
        ("Show the stored template named 'release-notes'.", "templates show release-notes"),
        ("Show the fragment stored under alias 'guidelines'.", "fragments show guidelines"),
        ("Show the default options for the model 'ops-mini'.", "models options show ops-mini"),
        ("Show installed plugins that implement the register_models hook.", "plugins --hook register_models"),
        ("Show stored schema with ID 'example-schema'.", "schemas show example-schema"),
    ]),
    ("", [
        ("Back up the log database to 'history.db'.", "logs backup history.db"),
        ("Set the model alias 'daily' to point at model 'mini'.", "aliases set daily mini"),
        ("Remove the model alias 'retired'.", "aliases remove retired"),
        ("Disable prompt logging.", "logs off"),
        ("Set 'local-embed' as the default embedding model.", "embed-models default local-embed"),
        ("Remove the fragment alias 'old-guide'.", "fragments remove old-guide"),
        ("Set the default chat model to 'fast'.", "models default fast"),
    ]),
    ("", [
        ("Which command would display the saved key named 'research'.", "keys get research"),
        ("List installed plugins, including built-in plugins.", "plugins --all"),
        ("Show the path of the embedding collections database.", "collections path"),
        ("List saved template names.", "templates list"),
        ("Clear the saved temperature default on model 'alpha'.", "models options clear alpha temperature"),
        ("List saved model options.", "models options list"),
        ("List the names of saved API keys.", "keys list"),
    ]),
)


def cases(split):
    for family, (command, rows) in enumerate(FAMILIES):
        for index, (request, args) in enumerate(rows):
            if ("development", "audit", "field")[(index + family) % 7 // 3] == split:
                yield {
                    "caseId": f"cli-{family + 1:02}-{index + 1}",
                    "input": request,
                    "expected": " ".join(filter(None, ("llm", command, args))),
                }
