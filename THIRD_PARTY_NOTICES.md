# Third-party notices

tokenburn re-implements the report logic of ccusage and ships pricing snapshots derived from the sources below.

## ccusage

The aggregation, deduplication, pricing-resolution and blocks algorithms, the built-in price table, `src/pricing/data/models-dev.json`, `src/pricing/data/fast-multiplier-overrides.json` and `src/adapters/data/codex-auto-review-fallbacks.json` are derived from ccusage (https://github.com/ccusage/ccusage, commit 3f27abd, v20.0.26).

```text
MIT License

Copyright (c) 2025 ryoppippi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LiteLLM model prices

`src/pricing/data/litellm.json` is a compacted subset of `model_prices_and_context_window.json` from https://github.com/BerriAI/litellm at revision 22b36cbcf6583e2d6b552cc0e87ae6ab82c46341. See that repository for its license terms.

## models.dev

The models.dev snapshot inside `src/pricing/data/models-dev.json` comes from https://models.dev via ccusage. See https://github.com/sst/models.dev for its license terms.
