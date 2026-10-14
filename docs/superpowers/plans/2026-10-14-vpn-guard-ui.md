# VPN Guard panel consistency

Use the shared plugin UI standard. Keep actual VPN evidence, manual block and selected protection mode distinct. Put current status and manual block first; collapse machine configuration, optional automation integration and native-plugin suspension. Native ownership or pending recovery must remain visible and reachable even when its policy is disabled. Settings use checkbox controls; one-time actions use explicit verbs and never imply a setting toggle restores resources.

Use the same control heights, side padding and bounded action grid. Avoid horizontal overflow in narrow BB panels even inside a wide desktop window; nested technical details must not inherit top-level section spacing. Normal vertical page scrolling remains available on small screens. Surface unavailable VPN evidence without presenting it as connected. Preserve server checks, ownership journal, automation revision checks and explicit restoration.

Steps: add behavioral UI regressions; restructure the real component and bilingual copy; build an isolated synthetic preview using the actual component; inspect 320/390/desktop, RU/EN, light/dark and unavailable/recovery states; typecheck/build/focused tests; publication gate, independent oxi-review and CI before release. Do not change live protection or restore providers during UI tests.
