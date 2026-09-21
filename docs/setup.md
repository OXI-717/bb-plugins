# Set up your own pool

1. Install and configure BB using the [official documentation](https://github.com/get-bb/bb). Choose the server and execution hosts you want to own the work. This plugin requires a working BB installation.
2. Configure BB's authenticated remote access for the computer and phone you intend to use. Verify that both devices can reach your BB instance before adding the pool. Do not expose the provider proxy as an unauthenticated public endpoint.
3. Install Account Pool Balanced using the repository README. Keep BB's built-in Account Pooler disabled while this plugin is enabled.
4. Add your own accounts in the pool settings. For Claude/Codex, follow the browser/device login instructions returned by BB. Supply provider keys through the settings UI or supported stdin flows, never through a chat transcript.
5. Inspect `bb pool status`, select the routing strategy, and run a short task for each configured provider. Check the subscription indicator and quota observation after the task.
6. On the phone, use the remote access offered by your BB installation. This release does not claim a separately tested native mobile client.

## A prompt for a setup agent

> Set up BB on my chosen server using the official BB documentation, then install Account Pool Balanced from `https://github.com/OXI-717/bb-plugins`. Read its README and use the `account-pool-balanced` release tags. Keep the built-in pool disabled, preserve any existing settings, and do not remove a live plugin. Ask me for the target server if it is not already known.
>
> Help me add multiple accounts, including multiple accounts of the same provider, using the supported login or secret-input flows. Never request that I paste tokens into the conversation. Configure authenticated BB access from my computer and phone, then verify routing with short tasks. Give me the actual connection instructions, update/backup procedure and any unverified platform or provider limitations. Do not claim that Devin, arbitrary consumer subscriptions or a separate mobile app are supported without verifying them.
