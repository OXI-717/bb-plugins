# Automation model and project visibility

Expose bounded agent configuration metadata in the catalog without copying prompts, scripts or credentials. BB collectors and manual refresh must agree. Existing task identity and history remain unchanged.

1. Add optional agent configuration (provider, model, reasoning, tier, new-thread/existing-thread model selection) to the task contract. Existing snapshots remain compatible.
2. Show model prominently in list rows and a dedicated detail section. Existing-thread jobs must clearly distinguish stored configuration from effective thread settings; script jobs must not be described as free of model calls.
3. Always render project association, distinguish unlinked tasks, support a no-project filter and project-name search. Preserve project-specific actions; no guessed mappings.
4. Test refresh transitions, collector privacy, missing metadata, model inheritance and project filtering. Build and inspect the installed panel, then release through independent review and hosted CI.
