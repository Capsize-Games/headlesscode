# Local-model output summarization — honest evaluation report

Date: 2026-08-01. Environment: local machine with Ollama 0.24.0 (RTX 5080,
16GB VRAM), repo worktree `outsumm`.

## Bottom line

**Built, working, opt-in only — and NOT recommended as a default.**

The feature does what it claims for its best case (a large log with a buried
failure): the local model recovers information that today's blunt 30KB
truncation throws away, with a transparency header so the cloud model (and a
human reading `harness.log`) knows it is reading a summary, not raw output.
But summary quality is model-dependent, prompt-sensitive, and degrades on
very large inputs. Per the task's own bar ("be willing to conclude this
doesn't work reliably enough yet"), this is not good enough to enable for
everyone — it stays behind `HEADLESSCODE_LOCAL_SUMMARIZATION=1`, default OFF.

## Models evaluated (real pulls + real runs)

Pulled via `ollama pull` and compared on real hardware:

| Model | Verdict |
|---|---|
| `qwen3:8b` | **Faithful** — keeps errors/listing lines verbatim, never fabricated. BUT needs `think: false` (it reasons by default and leaves `content` empty), compresses listings poorly (keeps most lines), and hits its 700-token output budget on big inputs. |
| `llama3.1:8b` | **Aggressive compressor** — excellent at extracting just the 2 failures from a long test log. BUT **hallucinates**: without an explicit anti-fabrication rule it invented "Error:", "Exit code: 1", and merged/dropped grep lines. Too lossy for code listings. |

Default in the code is `qwen3:8b` (faithful > lossy). Both are overridable via
`HEADLESSCODE_SUMMARIZATION_MODEL`.

## Fixtures and real results

Fixtures live in [`recon/local-summ-fixtures/`](./local-summ-fixtures/), raw
model outputs in [`recon/local-summ-eval/`](../local-summ-eval/). Three
realistic cases, each with a buried needle:

### 1. Long test-run log (needle: 2 FAIL lines + exact assertions)
- **qwen3:8b**: kept the failures + assertions verbatim, but ALSO kept ~90%
  of the passing `ok` lines (poor compression; hit output budget mid-file).
- **llama3.1:8b**: perfect extraction — only the 2 failures + `npm ERR!`.
- **Verdict**: both found the needle; llama3.1 compressed better.

### 2. Large `npm install` log (needle: EBADENGINE error)
- **Both** kept the full `EBADENGINE` block verbatim. qwen3 kept everything
  (barely compressed); llama3.1 condensed but preserved the core.
- **Verdict**: both fine.

### 3. Big `grep -r` listing (needle: a specific match line at ~line 1200)
- With a generic "keep errors verbatim" prompt, **both models discarded the
  listing entirely** ("no errors found") — the prompt must tell the model the
  output IS a listing whose entries are the content.
- With the corrected prompt, qwen3 kept lines verbatim but ran out of output
  budget before reaching the late needle; llama3.1 paraphrased/merged lines
  (lossy for code).
- **Verdict**: faithful but budget-bound; a needle past the model's own output
  budget is still missed.

## Prompt engineering findings (load-bearing)

1. **`think: false` is mandatory for qwen3-class models** — verified live:
   without it, `message.content` comes back empty (everything goes to
   `message.thinking`) and the summarizer must treat that as a failure.
2. **The prompt must name the output type** (error log vs listing) or the
   model discards listing content.
3. **The prompt must forbid fabrication** or small models invent labels
   ("Error:", "Exit code: 1") and merged lines — the exact "confidently
   omit/mislead" failure the task warned about.

## The 60KB input window caveat

The summarizer sends at most the first 60KB of raw output to the model
(`MAX_SUMMARIZER_INPUT_CHARS`). For a 60KB+ log whose needle sits past that
window, the model summarizes a truncated view and may miss the needle — as
demonstrated in the real smoke test (a ~140KB log whose error line at ~120KB
was invisible to the model). The transparency header flags when the summary
itself was cut off (`model hit its output budget`), but the content-loss risk
is real and is exactly why this stays opt-in.

## Head-to-head demonstration (real executor, real Ollama)

Command printing ~56KB of noise with `ERROR: ... chunk 799 - config timeout`
buried at ~55KB:

- **Feature OFF (default)**: result is 30,059 chars, blunt-truncated at 30KB,
  the error line is **completely discarded**.
- **Feature ON (`qwen3:8b`)**: result is 3,344 chars, error line preserved
  verbatim, header: `[Output summarized by local model (qwen3:8b) — original
  was 55949 chars; summary is 3192 chars; model hit its output budget,
  summary may be incomplete]`.

The core value proposition is real for the canonical "buried needle in a big
log" case.

## Recommendation

Ship as opt-in (built + tested + documented), leave OFF by default. The
failure handling is genuinely zero-risk to the main loop (any failure → exact
today's blunt truncation, never an error/hang). For an operator who wants to
try it: set `HEADLESSCODE_LOCAL_SUMMARIZATION=1`, keep `qwen3:8b` (or switch
to `llama3.1:8b` via `HEADLESSCODE_SUMMARIZATION_MODEL` for error-heavy logs),
and treat results as advisory — the transparency header tells the cloud model
what it's reading.
