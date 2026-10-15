#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for arg in "$@"; do
  case "$arg" in
    --sandbox|--check|--wait-idle|--help|-h) exec bash "$script_dir/upgrade-pool.sh" "$@" ;;
  esac
done
bb vpn-guard status --json | python3 -c '
import json,sys
s=json.load(sys.stdin)
if s["mode"]!="observe" or s.get("manualBlock") or s["suspendNativePluginsGlobally"] or s["ownedDisabledPlugins"] or s["ambiguousPluginChanges"]:
    raise SystemExit("Return Guard to Observe, release manual block and review owned changes before upgrading.")
'
# Do not replace either side of the protocol while requests prevent a paired update.
# The Pooler updater checks idleness again immediately before its own mutation.
bash "$script_dir/upgrade-pool.sh" --wait-idle
bb plugin update vpn-guard --yes
bb vpn-guard status --json | python3 -c '
import json,sys
s=json.load(sys.stdin)
if not s.get("serverHostId") or s["serverHostId"] not in s["hostIds"]:
    raise SystemExit("Select the BB/pool server machine in VPN Guard, then rerun this script.")
'
bash "$script_dir/upgrade-pool.sh" "$@"
bb pool config set vpnGuardEnabled true
bb pool status --json | python3 -c '
import json,sys
s=json.load(sys.stdin)
if not s.get("vpn",{}).get("guardEnabled"):
    raise SystemExit("Pooler did not confirm Guard linkage.")
print("PASS: VPN Guard and Pooler upgraded; fail-closed linkage enabled.")
print("Protected providers currently blocked:", ", ".join(s["vpn"]["blockedProviders"]) or "none")
'
