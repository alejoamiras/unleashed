# Font sources

Every font here is OFL-licensed (licence text alongside each). They come from [google/fonts](https://github.com/google/fonts) at commit `23e54b51ddffbc7713c583748e3bd86f62b1fa4a`.

Each upstream file was checked at vendoring against the git blob id GitHub reports for its path at that commit. It was then converted locally with fonttools 4.66.0 and brotli 1.1.0. Nothing converts fonts in CI.

The Sixtyfour subset was last cut in a scratch virtualenv from `pip install --require-hashes`, pinning the CPython 3.12 manylinux x86_64 wheels by the sha256 PyPI lists:

- `fonttools-4.66.0-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`: `aea0cc5609a5f2a2500f91bd6e1989fdd22da0f225be00dc1c4cec775838a7d0`
- `Brotli-1.1.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`: `d0c5516f0aed654134a2fc936325cc2e642f8a0e096d075209672eb321cff408`

The same tools re-cut the previous 39-code-point subset byte for byte (`e080370f…64dd`) before adding U+0055.

`fonts.test.ts` recomputes the output hashes in the table below. That test detects drift only; the upstream check above is the provenance.

| File | Upstream path | Upstream blob | Upstream sha256 | Conversion | Output sha256 | Bytes |
|---|---|---|---|---|---|---|
| `AtkinsonHyperlegibleNext.woff2` | `ofl/atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext[wght].ttf` | `92a357554bdcca62a7e80d5e3724bf4eb8932e5e` | `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745` | woff2, no subsetting | `e8415a1bc8f0a99fdbbcbb4e21d519d98a945fcd6db42062cb96c6aa17166bcc` | 48168 |
| `AtkinsonHyperlegibleMono.woff2` | `ofl/atkinsonhyperlegiblemono/AtkinsonHyperlegibleMono[wght].ttf` | `d5208f64392e7e15624be4afff7f1283bbaf8069` | `5ce8b1698d1ded7dff2178c1a3ad159470085a58ea239e8b2cb88f4fb4a6f646` | woff2, no subsetting | `f90dd16bc351abdfaac2076cffe1bf780b8deb81581459ffdd2d6b6c529d6b31` | 25800 |
| `SixtyfourConvergence-subset.woff2` | `ofl/sixtyfourconvergence/SixtyfourConvergence[BLED,SCAN,XELA,YELA].ttf` | `1617be9fd39765f7397c019640be9d7184a148ad` | `aa8c653e04d6211debe5f5d1b7e851a64345a61b2a3c0a5a295cddb0f1e71688` | `pyftsubset --unicodes=U+0020,U+002C,U+002E,U+0030-0039,U+0055,U+0061-007A --layout-features='*' --flavor=woff2` | `2e89cec4c6ba710ba39cef2529555a9c53dc2490497ec654c9454cb52abdab76` | 4076 |

## What the outputs contain

These were inspected after conversion.

- **Atkinson Hyperlegible Next**
  - Axis: `wght` 200–800, default 400.
  - GSUB: `aalt case ccmp frac locl ordn pnum sups tnum`.
  - 392 glyphs.
  - Its default digits are proportional, so amounts set `font-variant-numeric: tabular-nums`.
- **Atkinson Hyperlegible Mono**
  - Axis: `wght` 200–800. The default instance is 200, so text always sets a weight.
  - GSUB: `aalt case ccmp frac locl ordn sups zero`.
  - 380 glyphs.
- **Sixtyfour Convergence (subset)**
  - Axes: `SCAN` −53–100, `BLED` 0–100, `XELA` −100–100 and `YELA` −100–100. All defaults are 0.
  - GSUB: `aalt ss02 ss03 ss04`.
  - Tables: COLR (version 1) and CPAL survive, so the glyphs keep their fixed colour palette.
  - 91 glyphs cover 40 code points: digits, `,`, `.`, space, `U` and `a`–`z`. The boards set only "Unleashed" and digits in this face.
  - At 4076 bytes it is below Vite's default inline limit. The app's build therefore never inlines fonts, because `font-src 'self'` blocks `data:` fonts.

## Licences

| File | Upstream blob of `OFL.txt` |
|---|---|
| `OFL-AtkinsonHyperlegibleNext.txt` | `88955733b80000358ef3e5521f3369b276e066a9` |
| `OFL-AtkinsonHyperlegibleMono.txt` | `63eb4ba5ba8498a919c911b9cf2b3091b1447096` |
| `OFL-SixtyfourConvergence.txt` | `241ef1a5e702b2ef190e380b801ef9c97d2f36ef` |
