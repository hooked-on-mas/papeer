# Output fonts

The two bundled static TrueType fonts are weight 400 instances of Google Fonts Noto Sans JP and Noto Serif JP. Their source variable fonts and SIL OFL 1.1 licenses are available at:

- https://github.com/google/fonts/tree/main/ofl/notosansjp — source SHA-256 `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`
- https://github.com/google/fonts/tree/main/ofl/notoserifjp — source SHA-256 `2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc`

Reproduce using fontTools 4.65.0: `python -m fontTools.varLib.instancer INPUT.ttf wght=400 --update-name-table --output OUTPUT.ttf`. Generated Sans SHA-256 `8add1922f3802d41a5911b1669e83659da95b2dfb57a53f131622393d332d967`; Serif `2a7968f72a1e5465339aac7e11bb934980b20241ab7404078ddac8078480615f`. Both license texts are emitted in the distribution. Source variable fonts and exact evidence are retained in `checkpoints/shared-app/2026-10-29-p2/font-r1`.
