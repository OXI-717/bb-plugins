---
name: model-connections
description: Inspect local and pooled model connections and select a model with the separate BB model chooser.
---

# Model connections

Open **Модели** in a thread header or BB navigation. Local connections and Pooler are separate groups. Choose the execution machine on the navigation page; a thread panel uses that thread's environment.

Read connections with `bb model-connections list --host MACHINE_ID --json` or `bb model-connections list --thread THREAD_ID --json`.

Use the panel's explicit apply action to change the current provider's model on the next turn. Do not stop the current turn. Different providers require the explicit new-thread form; review and submit it before any work starts. Hiding a connection affects this chooser only and must not be replaced with `bb provider disable`.

Inspect plugin RPC schemas before mutations. Reuse a creation request ID only for the identical request. An uncertain creation is held for inspection rather than resent. Never claim that a configuration snapshot proves upstream reachability or selects a particular account.
